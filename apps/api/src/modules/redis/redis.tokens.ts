export const REDIS_CLIENT = Symbol.for('repobuddy:redis')
export type RedisClient = import('ioredis').default
