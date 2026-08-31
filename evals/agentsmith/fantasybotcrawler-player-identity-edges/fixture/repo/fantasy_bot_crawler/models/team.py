from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Team:
    team_id: str

