import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('refuses to start without AOR_SDK_KEY (fail closed)', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/AOR_SDK_KEY/);
  });

  it('treats a blank AOR_SDK_KEY as missing', () => {
    expect(() => loadConfig({ AOR_SDK_KEY: '  ' })).toThrow(/AOR_SDK_KEY/);
  });

  it('uses the live billing when the key is set and the dev flag is not', () => {
    const config = loadConfig({ AOR_SDK_KEY: 'aorsk_live', OARS_PUBLIC_URL: 'https://agent.example' });

    expect(config.fakeBilling).toBe(false);
    expect(config.sdkKey).toBe('aorsk_live');
  });

  it('uses the fake billing only when OARS_DEV_FAKE_BILLING is exactly 1', () => {
    expect(loadConfig({ OARS_DEV_FAKE_BILLING: '1' }).fakeBilling).toBe(true);
    expect(loadConfig({ OARS_DEV_FAKE_BILLING: '1', AOR_SDK_KEY: 'aorsk_live' }).fakeBilling).toBe(true);
  });

  it.each(['0', 'true', 'yes', ''])('does not take OARS_DEV_FAKE_BILLING=%j for the dev flag', (flag) => {
    expect(() => loadConfig({ OARS_DEV_FAKE_BILLING: flag })).toThrow(ConfigError);
    expect(loadConfig({ OARS_DEV_FAKE_BILLING: flag, AOR_SDK_KEY: 'aorsk_live', OARS_PUBLIC_URL: 'https://agent.example' }).fakeBilling).toBe(false);
  });

  it('defaults to port 8080, the production API and the starter price refs', () => {
    const config = loadConfig({ AOR_SDK_KEY: 'k', OARS_PUBLIC_URL: 'https://agent.example' });

    expect(config.port).toBe(8080);
    expect(config.apiUrl).toBe('https://api.manyoars.com');
    expect(config.priceRefs).toEqual(['calls-100', 'calls-1000']);
  });

  it('reads PORT, OARS_API_URL and OARS_PRICE_REFS', () => {
    const config = loadConfig({ AOR_SDK_KEY: 'k', OARS_PUBLIC_URL: 'https://agent.example', PORT: '3000', OARS_API_URL: 'http://127.0.0.1:4010', OARS_PRICE_REFS: 'big, small ,' });

    expect(config.port).toBe(3000);
    expect(config.apiUrl).toBe('http://127.0.0.1:4010');
    expect(config.priceRefs).toEqual(['big', 'small']);
  });

  it('rejects a PORT that is not a port number', () => {
    expect(() => loadConfig({ AOR_SDK_KEY: 'k', OARS_PUBLIC_URL: 'https://agent.example', PORT: 'eighty' })).toThrow(/PORT/);
  });

  it('refuses to start without OARS_PUBLIC_URL, naming it, unless the dev flag selected the fake', () => {
    expect(() => loadConfig({ AOR_SDK_KEY: 'k' })).toThrow(ConfigError);
    expect(() => loadConfig({ AOR_SDK_KEY: 'k' })).toThrow(/OARS_PUBLIC_URL/);
    expect(() => loadConfig({ AOR_SDK_KEY: 'k', OARS_PUBLIC_URL: '  ' })).toThrow(/OARS_PUBLIC_URL/);
    expect(loadConfig({ OARS_DEV_FAKE_BILLING: '1' }).publicUrl).toBe('http://localhost:8080');
    expect(loadConfig({ OARS_DEV_FAKE_BILLING: '1', PORT: '3000' }).publicUrl).toBe('http://localhost:3000');
  });

  it('reads OARS_PUBLIC_URL without its trailing slash', () => {
    expect(loadConfig({ AOR_SDK_KEY: 'k', OARS_PUBLIC_URL: ' https://agent.example/ ' }).publicUrl).toBe('https://agent.example');
  });

  it.each(['agent.example', 'ftp://agent.example', 'https://agent.example/?a=b', 'https://agent.example/#x'])('rejects OARS_PUBLIC_URL=%s', (url) => {
    expect(() => loadConfig({ AOR_SDK_KEY: 'k', OARS_PUBLIC_URL: url })).toThrow(/OARS_PUBLIC_URL must be/);
  });
});
