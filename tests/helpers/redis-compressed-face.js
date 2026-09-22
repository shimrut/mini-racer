import { gunzipSync } from 'node:zlib';

const COMPRESSION_PREFIX = '__gz:b64__:';

export function decodeCompressedValue(value) {
    return typeof value === 'string' && value.startsWith(COMPRESSION_PREFIX)
        ? gunzipSync(Buffer.from(value.slice(COMPRESSION_PREFIX.length), 'base64')).toString('utf8')
        : value;
}

export function asCompressedRedis(client) {
    return new Proxy(client, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            if (prop === 'hGet' || prop === 'get') {
                return async (...args) => decodeCompressedValue(await value.apply(target, args));
            }
            if (prop === 'hMGet' || prop === 'mGet') {
                return async (...args) => (await value.apply(target, args)).map(decodeCompressedValue);
            }
            return value.bind(target);
        },
    });
}
