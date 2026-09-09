from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Team:
    # Unreferenced sibling control.
    team_id: str
