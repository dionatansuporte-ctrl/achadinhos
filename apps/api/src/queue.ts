import IORedis from 'ioredis';
import { Queue } from 'bullmq';
const connection=new IORedis(process.env.REDIS_URL||'redis://localhost:6379',{maxRetriesPerRequest:null});
export const promotionQueue=new Queue('promotions',{connection});
