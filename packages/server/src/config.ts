import { SERVER_PORT } from '@mmo/shared';

export interface Config {
  port: number;
  mapSeed: number;
  maxPlayers: number;
  databaseUrl: string;
  redisUrl: string;
}

/** 读取配置。本地开发时先加载 packages/server/.env，已经存在的环境变量优先。 */
export function loadConfig(): Config {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch (err) {
    // 没有 .env 是正常情况（比如线上直接用环境变量），其他错误要报出来。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return {
    port: Number(process.env.PORT) || SERVER_PORT,
    mapSeed: Number(process.env.MAP_SEED) || 20261127,
    maxPlayers: Number(process.env.MAX_PLAYERS) || 2000,
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}。请参考 packages/server/.env.example 创建 packages/server/.env。`);
  }
  return value;
}
