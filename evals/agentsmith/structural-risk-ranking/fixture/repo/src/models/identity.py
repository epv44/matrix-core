class ExternalIdentity:
    def __init__(self, provider: str, external_id: str, normalized: bool = True) -> None:
        # External identity is shared by persistence and factories.
        self.provider = provider
        self.external_id = external_id
        self.normalized = normalized
