from src.models.player import Player
from src.models.identity import ExternalIdentity


class PlayerRepository:
    def save(self, player: Player, identity: ExternalIdentity) -> tuple[str, str]:
        return player.player_id, identity.external_id

