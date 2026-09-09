from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Player:
    # Shared player domain symbol.
    id: str
    name: str
    name_key: str


@dataclass(frozen=True, slots=True)
class ExternalIdentity:
    provider: str
    external_id: str
