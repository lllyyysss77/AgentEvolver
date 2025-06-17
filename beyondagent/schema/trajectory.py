from typing import List, Dict

from pydantic import BaseModel, Field


class Reward(BaseModel):
    outcome: float = Field(default=0.0)
    description: str = Field(default="Outcome 1 denotes success, and 0 denotes failure.")

    metadata: dict = Field(default_factory=dict)


class Trajectory(BaseModel):
    data_id: str = Field(default="")
    rollout_id: str = Field(default="")

    steps: List[Dict[str, str]] = Field(default_factory=list)
    query: str = Field(default="")

    is_terminated: bool = Field(default=False)
    reward: Reward = Field(default_factory=Reward)

    metadata: dict = Field(default_factory=dict)
