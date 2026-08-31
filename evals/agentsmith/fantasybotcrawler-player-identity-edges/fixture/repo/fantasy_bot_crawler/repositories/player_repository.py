from fantasy_bot_crawler.models.player import ExternalIdentity, Player


class PlayerRepository:
    def save(self, player: Player, identity: ExternalIdentity) -> tuple[str, str]:
        return player.id, identity.external_id

