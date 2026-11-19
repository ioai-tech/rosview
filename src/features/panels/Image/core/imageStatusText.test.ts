import { describe, expect, it } from 'vitest';
import { createRosViewIntl } from '@/shared/intl/createRosViewIntl';
import { getStatusText } from './imageStatusText';

describe('image panel status text', () => {
  it('follows the UI language for every built-in state', () => {
    const zh = createRosViewIntl('zh').formatMessage;
    expect(getStatusText({ phase: 'idle' }, zh)).toBe('等待图像数据');
    expect(getStatusText({ phase: 'error' }, zh)).toBe('图像解码失败');
    expect(getStatusText({ phase: 'stalled' }, zh)).toBe('视频卡顿，正在恢复');
    expect(getStatusText({ phase: 'decoding' }, zh)).toBe('正在解码最新一帧…');
    const ja = createRosViewIntl('ja').formatMessage;
    expect(getStatusText({ phase: 'idle' }, ja)).toBe('画像データを待機中');
  });

  it('keeps a specific error message and hides text once a frame is shown', () => {
    const en = createRosViewIntl('en').formatMessage;
    expect(getStatusText({ phase: 'error', message: 'HTTP 404' }, en)).toBe('HTTP 404');
    expect(getStatusText({ phase: 'ready', width: 640, height: 480 }, en)).toBeNull();
  });

  it('says why the frame is missing when the player could not read it', () => {
    const reason = 'No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.';
    expect(getStatusText({ phase: 'idle' }, createRosViewIntl('en').formatMessage, reason)).toBe(
      `Could not read this frame: ${reason}`,
    );
    expect(getStatusText({ phase: 'idle' }, createRosViewIntl('zh').formatMessage, reason)).toBe(`无法读取这一帧：${reason}`);
  });
});
