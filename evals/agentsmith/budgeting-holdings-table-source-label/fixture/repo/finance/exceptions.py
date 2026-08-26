class AppError(Exception):
    pass


class NotFoundError(AppError):
    pass


class ConfigError(AppError):
    pass


class KeychainError(AppError):
    pass


class DatabaseError(AppError):
    pass


class PlaidError(AppError):
    pass


class LinkError(PlaidError):
    pass


class PlaidSyncError(PlaidError):
    pass


class PlaidRateLimitError(PlaidSyncError):
    pass
