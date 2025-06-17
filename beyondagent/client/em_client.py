from typing import List

from pydantic import Field

from beyondagent.schema.trajectory import Trajectory
from beyondagent.utils.http_client import HttpClient


class EMClient(HttpClient):
    base_url: str = Field(default="http://localhost:8001")

    def call_context_generator(self, trajectory: Trajectory, retrieve_top_k: int = 1, workspace_id: str = "",
                               **kwargs) -> str:
        self.url = self.base_url + "/context_generator"
        json_data = {
            "trajectory": trajectory.model_dump(),
            "retrieve_top_k": retrieve_top_k,
            "workspace_id": workspace_id,
            "metadata": kwargs
        }
        response = self.request(json_data=json_data, headers={"Content-Type": "application/json"})

        # TODO return raw experience instead of context @jinli
        return response["context_msg"]["content"]

    def call_summarizer(self, trajectories: List[Trajectory], workspace_id: str = "", **kwargs):
        self.url = self.base_url + "/summarizer"
        json_data = {
            "trajectories": [x.model_dump() for x in trajectories],
            "workspace_id": workspace_id,
            "metadata": kwargs
        }
        response = self.request(json_data=json_data, headers={"Content-Type": "application/json"})
        return response["experiences"]


if __name__ == "__main__":
    client = EMClient()
    traj = Trajectory(
        steps=[
            {
                "role": "user",
                "content": "What is the capital of France?"
            },
            {
                "role": "assistant",
                "content": "Paris"
            }
        ],
        query="What is the capital of France?"
    )
    workspace_id = "w_agent_enhanced"
    print(client.call_context_generator(traj, retrieve_top_k=3, workspace_id=workspace_id))
    print(client.call_summarizer(trajectories=[traj], workspace_id=workspace_id))
