import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GotzjiGettingStarted } from '../src/renderer/GotzjiGettingStarted.js';

describe('guided first use', () => {
  it('separates the local tunnel from an unverified ChatGPT caller', () => {
    const html = renderToStaticMarkup(createElement(GotzjiGettingStarted, {
      hostState: 'ready', projectName: 'My project', projectKnown: true, connectionState: 'ready',
      openProjects: () => undefined, openSettings: () => undefined, openDoctor: () => undefined,
    }));
    expect(html).toContain('My project');
    expect(html).toContain('เชื่อมต่อในเครื่องพร้อม');
    expect(html).toContain('ยังไม่ได้ยืนยันการเรียกจาก ChatGPT');
    expect(html).toContain('คัดลอกคำสั่งทดสอบ');
  });
  it('does not claim setup is ready when the current connection or project is missing', () => {
    const html = renderToStaticMarkup(createElement(GotzjiGettingStarted, {
      hostState: 'unavailable', projectName: null, projectKnown: true, connectionState: null,
      openProjects: () => undefined, openSettings: () => undefined, openDoctor: () => undefined,
    }));
    expect(html).toContain('ยังไม่พบโครงการที่เลือก');
    expect(html).toContain('ยังไม่ทราบสถานะการเชื่อมต่อ');
    expect(html).toContain('disabled');
  });
  it('does not display a stale project when its current status is unknown', () => {
    const html = renderToStaticMarkup(createElement(GotzjiGettingStarted, {
      hostState: 'ready', projectName: 'Previous project', projectKnown: false, connectionState: 'ready',
      openProjects: () => undefined, openSettings: () => undefined, openDoctor: () => undefined,
    }));
    expect(html).toContain('ยังอ่านสถานะโครงการไม่ได้');
    expect(html).not.toContain('Previous project');
    expect(html).toContain('disabled');
  });
});
