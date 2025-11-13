import { RetentionPolicy, connect, JSONCodec, type JetStreamClient, type JetStreamManager, type NatsConnection, type Subscription } from 'nats';

const jsonCodec = JSONCodec();

export interface NatsBundle {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export async function connectNats(url: string): Promise<NatsBundle> {
  const nc = await connect({ servers: url });
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  return { nc, js, jsm };
}

export async function ensureStream(
  jsm: JetStreamManager,
  name: string,
  subjects: string[]
): Promise<void> {
  try {
    await jsm.streams.info(name);
  } catch {
    await jsm.streams.add({ name, subjects, retention: RetentionPolicy.Limits, max_age: 0 });
  }
}

export async function publishJson(
  js: JetStreamClient,
  subject: string,
  payload: unknown
): Promise<void> {
  await js.publish(subject, jsonCodec.encode(payload));
}

export function subscribeJson<T>(
  nc: NatsConnection,
  subject: string,
  handler: (data: T) => Promise<void> | void
): Subscription {
  const sub = nc.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const data = jsonCodec.decode(msg.data) as T;
        await handler(data);
        if (typeof (msg as any).ack === 'function') {
          (msg as any).ack();
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[nats] handler failed', err);
        if (typeof (msg as any).nak === 'function') {
          (msg as any).nak();
        }
      }
    }
  })().catch((err) => console.error('[nats] subscription failed', err));
  return sub;
}
