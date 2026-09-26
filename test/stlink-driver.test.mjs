import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStlinkDriver, summarizeDevices } from '../src/stlink-driver.mjs';
const id = 'USB\\VID_0483&PID_374B&MI_00\\TEST';
test('ST-Link driver diagnosis distinguishes missing, failed, healthy and absent devices', () => {
  assert.equal(summarizeDevices([{ id, problem: 28 }]).state, 'missing');
  assert.equal(summarizeDevices([{ id, problem: 43 }]).state, 'error');
  assert.equal(summarizeDevices([{ id, problem: 0, service: 'WinUSB' }]).state, 'ready');
  assert.equal(summarizeDevices([{ id }]).state, 'unknown');
  assert.equal(summarizeDevices([{ id: 'USB\\VID_0483&PID_5740\\TEST', problem: 0 }]).state, 'absent');
  assert.equal(summarizeDevices([{ id, problem: 0 }, { id: id + '2', problem: 28 }]).state, 'missing');
});
test('query failure is unknown, never missing driver; other systems do not run PowerShell', async () => {
  const execute = async () => { throw new Error('Access denied'); };
  assert.equal((await checkStlinkDriver({ platform: 'win32', execute })).state, 'unknown');
  assert.equal((await checkStlinkDriver({ platform: 'linux', execute })).state, 'unsupported');
  assert.equal((await checkStlinkDriver({ platform: 'win32', execute: async () => ({ stdout: JSON.stringify([{ id, problem: 0 }]) }) })).state, 'ready');
});
