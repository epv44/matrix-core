from src.models.player import Player
from src.models.identity import ExternalIdentity

def make_player(player_id: str, name: str, external_id: str) -> tuple[Player, ExternalIdentity]:
    return Player(player_id, name), ExternalIdentity("ESPN", external_id)
