import { describe, expect, it } from 'vitest';
import {
  decodeClientMsg,
  decodeServerMsg,
  encode,
  MAP_LAYOUT_VERSION,
  MAX_NAME_LENGTH,
  MAX_TOKEN_LENGTH,
  MAX_TRADE_COUNT,
  sanitizeName,
} from '../src/index';

describe('protocol', () => {
  it('合法的客户端消息能往返编解码', () => {
    const join = { t: 'join', token: 'abc123', mapVersion: MAP_LAYOUT_VERSION } as const;
    expect(decodeClientMsg(encode(join))).toEqual(join);
    expect(decodeClientMsg(encode({ t: 'moveTo', x: 1.5, z: -2 }))).toEqual({ t: 'moveTo', x: 1.5, z: -2 });
    expect(decodeClientMsg(encode({ t: 'ping', c: 42 }))).toEqual({ t: 'ping', c: 42 });
    expect(decodeClientMsg(encode({ t: 'target', id: 17 }))).toEqual({ t: 'target', id: 17 });
    expect(decodeClientMsg(encode({ t: 'target', id: 0 }))).toEqual({ t: 'target', id: 0 });
    expect(decodeClientMsg(encode({ t: 'use', item: 'potion' }))).toEqual({ t: 'use', item: 'potion' });
    expect(decodeClientMsg(encode({ t: 'equip', item: 'sword' }))).toEqual({ t: 'equip', item: 'sword' });
    expect(decodeClientMsg(encode({ t: 'unequip' }))).toEqual({ t: 'unequip' });
    expect(decodeClientMsg(encode({ t: 'buy', item: 'potion', count: 2 }))).toEqual({ t: 'buy', item: 'potion', count: 2 });
    expect(decodeClientMsg(encode({ t: 'sell', item: 'sword', count: 1 }))).toEqual({ t: 'sell', item: 'sword', count: 1 });
  });

  it('服务端能认出没有地图版本的旧客户端', () => {
    expect(decodeClientMsg('{"t":"join","token":"abc123"}')).toEqual({ t: 'join', token: 'abc123' });
  });

  it('拒绝格式不对的客户端消息', () => {
    for (const raw of [
      'not json',
      'null',
      '42',
      '[]',
      '{}',
      '{"t":"unknown"}',
      '{"t":"join"}',
      '{"t":"join","token":5}',
      '{"t":"join","token":""}',
      '{"t":"join","token":"abc123","mapVersion":"2"}',
      '{"t":"join","token":"abc123","mapVersion":null}',
      '{"t":"join","token":"abc123","mapVersion":0}',
      '{"t":"join","token":"abc123","mapVersion":-1}',
      '{"t":"join","token":"abc123","mapVersion":1.5}',
      '{"t":"join","token":"abc123","mapVersion":1e30}',
      '{"t":"join","name":"张三"}',
      `{"t":"join","token":"${'a'.repeat(MAX_TOKEN_LENGTH + 1)}"}`,
      '{"t":"moveTo","x":"1","z":2}',
      '{"t":"moveTo","x":1}',
      '{"t":"moveTo","x":1e999,"z":2}',
      '{"t":"ping","c":null}',
      '{"t":"target"}',
      '{"t":"target","id":"3"}',
      '{"t":"target","id":-1}',
      '{"t":"target","id":1.5}',
      '{"t":"target","id":1e30}',
      '{"t":"use"}',
      '{"t":"use","item":"wand"}',
      '{"t":"use","item":"toString"}',
      '{"t":"use","item":1}',
      '{"t":"equip"}',
      '{"t":"equip","item":"wand"}',
      '{"t":"equip","item":"hasOwnProperty"}',
      '{"t":"equip","item":null}',
      '{"t":"buy"}',
      '{"t":"buy","item":"potion"}',
      '{"t":"buy","item":"wand","count":1}',
      '{"t":"buy","item":"potion","count":0}',
      '{"t":"buy","item":"potion","count":-1}',
      '{"t":"buy","item":"potion","count":1.5}',
      '{"t":"buy","item":"potion","count":"2"}',
      '{"t":"buy","item":"potion","count":21}',
      '{"t":"buy","item":"potion","count":1e30}',
      '{"t":"sell","item":"sword"}',
      '{"t":"sell","item":"constructor","count":1}',
      '{"t":"sell","item":"sword","count":0}',
      '{"t":"sell","item":"sword","count":null}',
      '{"t":"sell","item":"sword","count":21}',
    ]) {
      expect(decodeClientMsg(raw), raw).toBeNull();
    }
  });

  it('解码时丢掉多余的字段', () => {
    expect(decodeClientMsg('{"t":"moveTo","x":1,"z":2,"speed":999}')).toEqual({ t: 'moveTo', x: 1, z: 2 });
    expect(decodeClientMsg('{"t":"unequip","item":"sword"}')).toEqual({ t: 'unequip' });
    expect(decodeClientMsg('{"t":"buy","item":"potion","count":2,"price":0}')).toEqual({ t: 'buy', item: 'potion', count: 2 });
  });

  it('买卖的数量在 1 到单次上限之间', () => {
    expect(decodeClientMsg('{"t":"buy","item":"potion","count":1}')).toEqual({ t: 'buy', item: 'potion', count: 1 });
    expect(decodeClientMsg(`{"t":"buy","item":"sword","count":${MAX_TRADE_COUNT}}`)).toEqual({
      t: 'buy',
      item: 'sword',
      count: MAX_TRADE_COUNT,
    });
    expect(decodeClientMsg('{"t":"sell","item":"sword","count":3}')).toEqual({ t: 'sell', item: 'sword', count: 3 });
    // 金币不能买卖，但这要看背包和价格，由服务器的 World 判定；这里只管格式。
    expect(decodeClientMsg('{"t":"sell","item":"gold","count":1}')).toEqual({ t: 'sell', item: 'gold', count: 1 });
  });

  it('服务端消息损坏时返回 null', () => {
    expect(decodeServerMsg('{"t":"leave","ids":[1]}')).toEqual({ t: 'leave', ids: [1] });
    expect(decodeServerMsg('{oops')).toBeNull();
    expect(decodeServerMsg('{"ids":[1]}')).toBeNull();
  });

  it('sanitizeName 去掉控制字符、截断并提供默认名', () => {
    expect(sanitizeName('  小明\n\t ', 'x')).toBe('小明');
    expect(sanitizeName('   ', '玩家7')).toBe('玩家7');
    expect(Array.from(sanitizeName('好'.repeat(50), 'x'))).toHaveLength(MAX_NAME_LENGTH);
  });
});
