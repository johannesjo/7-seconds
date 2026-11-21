import { describe, it, expect } from 'vitest';
import { backTarget, shouldExit, type BackScreens } from './back-button';

const none: BackScreens = {
  ageGate: false, settings: false, difficulty: false, matches: false,
  ranked: false, lobby: false, result: false, menu: false,
};

describe('backTarget', () => {
  it('ignores Back during gameplay', () => {
    expect(backTarget(none)).toBe('none');
  });

  it('ignores Back while the age gate is up, even over the menu', () => {
    expect(backTarget({ ...none, ageGate: true, menu: true })).toBe('none');
  });

  it('closes a dialog before acting on the menu beneath it', () => {
    expect(backTarget({ ...none, menu: true, settings: true })).toBe('settings');
    expect(backTarget({ ...none, menu: true, difficulty: true })).toBe('difficulty');
    expect(backTarget({ ...none, menu: true, matches: true })).toBe('matches');
    expect(backTarget({ ...none, menu: true, ranked: true })).toBe('ranked');
  });

  it('leaves the online lobby and the result screen', () => {
    expect(backTarget({ ...none, lobby: true })).toBe('lobby');
    expect(backTarget({ ...none, result: true })).toBe('result');
  });

  it('targets the menu when nothing is open on top', () => {
    expect(backTarget({ ...none, menu: true })).toBe('menu');
  });
});

describe('shouldExit', () => {
  it('needs an earlier press on the menu', () => {
    expect(shouldExit(10_000, null)).toBe(false);
  });

  it('exits on a second press while the 3.5 s hint is still showing', () => {
    expect(shouldExit(11_500, 10_000)).toBe(true);
    expect(shouldExit(13_500, 10_000)).toBe(true);
  });

  it('starts over once the hint is gone', () => {
    expect(shouldExit(13_501, 10_000)).toBe(false);
  });
});
