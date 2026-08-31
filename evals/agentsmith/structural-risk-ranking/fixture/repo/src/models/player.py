class Player:
    def __init__(self, player_id: str, name: str, source: str = "unknown") -> None:
        self.player_id = player_id
        self.name = name
        self.source = source
