import { describe, expect, it } from 'vitest';
import {
  decodeClientMsg,
  decodeServerMsg,
  encode,
  MAX_NAME_LENGTH,
  MAX_TOKEN_LENGTH,
  sanitizeName,
} from '../src/index';

describe('protocol', () => {
  it('合法的客户端消息能往返编解码', () => {
    expect(decodeClientMsg(encode({ t: 'join', token: 'abc123' }))).toEqual({ t: 'join', token: 'abc123' });
    expect(decodeClientMsg(encode({ t: 'moveTo', x: 1.5, z: -2 }))).toEqual({ t: 'moveTo', x: 1.5, z: -2 });
    expect(decodeClientMsg(encode({ t: 'ping', c: 42 }))).toEqual({ t: 'ping', c: 42 });
    expect(decodeClientMsg(encode({ t: 'target', id: 17 }))).toEqual({ t: 'target', id: 17 });
    expect(decodeClientMsg(encode({ t: 'target', id: 0 }))).toEqual({ t: 'target', id: 0 });
    expect(decodeClientMsg(encode({ t: 'use', item: 'potion' }))).toEqual({ t: 'use', item: 'potion' });
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
      '{"t":"use","item":"sword"}',
      '{"t":"use","item":"toString"}',
      '{"t":"use","item":1}',
    ]) {
      expect(decodeClientMsg(raw), raw).toBeNull();
    }
  });

  it('解码时丢掉多余的字段', () => {
    expect(decodeClientMsg('{"t":"moveTo","x":1,"z":2,"speed":999}')).toEqual({ t: 'moveTo', x: 1, z: 2 });
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
