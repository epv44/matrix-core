class Team:
    def __init__(self, team_id: str, sport: str = "football") -> None:
        # Unreferenced sibling control.
        self.team_id = team_id
        self.sport = sport
