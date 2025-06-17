from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict
from typing import List
from typing import Literal

from omegaconf import DictConfig
from verl import DataProto
from verl.workers.rollout.async_server import AsyncLLMServerManager

from beyondagent.module.agent_flow.base_agent_flow import BaseAgentFlow
from beyondagent.module.agent_flow.env_agent_flow import AgentFlow
from beyondagent.module.explorer_manager.env_worker import EnvWorker
from beyondagent.schema.trajectory import Trajectory


class BaseParallelEnvManager(object):
    def __init__(self, config: DictConfig, async_rollout_manager: AsyncLLMServerManager, max_parallel: int = 128,
                 **kwargs):
        super().__init__(**kwargs)

        self.config: DictConfig = config
        self.async_rollout_manager: AsyncLLMServerManager = async_rollout_manager
        self.max_parallel: int = max_parallel

        self.rollout_n = config.actor_rollout_ref.rollout.n
        self.model_name = self.async_rollout_manager.chat_scheduler.model_name
        self.tokenizer = self.async_rollout_manager.chat_scheduler.completion_callback.tokenizer
        self.pad_token_id = self.tokenizer.pad_token_id
        self.rollout_config = config.actor_rollout_ref.rollout

    def get_llm_chat_fn(self, sampling_params: dict = None) -> callable:
        def llm_chat(messages: List[Dict[str, str]], custom_sampling_params: dict = None) -> List[
            Dict[str, Any]]:
            """
            input messages: [{"role": "system", "value": "..."}, {"role": "user", "value": "..."}]
            output messages: [{"role": "assistant", "value": "..."}]
            """
            # TODO: sending sampling_params to rollout server
            updated_sampling_params = {}
            if sampling_params:
                updated_sampling_params.update(sampling_params)
            if custom_sampling_params:
                updated_sampling_params.update(custom_sampling_params)

            output_messages = []
            self.async_rollout_manager.submit_chat_completions(messages=messages,
                                                               sampling_params=updated_sampling_params)
            return output_messages

        return llm_chat

    def rollout_env_worker(self, task: Task, data_id: str, rollout_id: str, mode: Literal["sample", "validate"],
                           thread_index: int, **kwargs) -> Trajectory:
        """
        Process a single prompt in a thread-safe way.
        """

        # TODO add try exception
        sampling_params = dict(
            n=1,
            max_completion_tokens=self.rollout_config.response_length,
            temperature=self.rollout_config.temperature,
            top_p=self.rollout_config.top_p)

        if mode == "validate":
            sampling_params["temperature"] = self.rollout_config.val_kwargs.temperature
            sampling_params["top_k"] = self.rollout_config.val_kwargs.top_k
            sampling_params["top_p"] = self.rollout_config.val_kwargs.top_p

        llm_chat_fn = self.get_llm_chat_fn(sampling_params)
        agent_flow: BaseAgentFlow = AgentFlow(llm_chat_fn=llm_chat_fn, tokenizer=self.tokenizer, **kwargs)

        # FIXME pass env_type & task_id
        env_worker = EnvWorker(env_type=task.env_type, task_id=task.task_id, thread_index=thread_index)
        trajectory: Trajectory = env_worker.execute(data_id=data_id, rollout_id=rollout_id, agent_flow=agent_flow)

        return trajectory

    def rollout(self, tasks: List[Task], mode: Literal["sample", "validate"], **kwargs) -> List[Trajectory]:
        trajectory_list: List[Trajectory] = []
        with ThreadPoolExecutor(max_workers=self.max_parallel) as executor:
            futures = []
            for data_id, task in enumerate(tasks):
                for rollout_id in range(self.rollout_n):
                    thread_index = data_id * self.rollout_n + rollout_id
                    future = executor.submit(self.rollout_env_worker, task=task, data_id=str(data_id),
                                             rollout_id=str(rollout_id), mode=mode, thread_index=thread_index)
                    futures.append(future)

            for future in futures:
                # do not fail silently
                result = future.result()
                trajectory_list.append(result)

            trajectory_list = sorted(trajectory_list, key=lambda x: (x.data_id, x.rollout_id))
            return trajectory_list

    @staticmethod
    def to_dataproto(self, trajectories: List[Trajectory]) -> DataProto:
        raise NotImplementedError
