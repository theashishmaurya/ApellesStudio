// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the shared `ProjectSettingsForm`
 * (D-272): the ONE component both the Colorist tab's `ProjectSettingsModal`
 * (a dialog) and the Edit tab's docked `ProjectSettingsPanel` render.
 *
 * **Why a DOM test.** This form is pure presentation (`settings` in,
 * `onChange` patches out) — the thing worth proving at this level is that
 * every control emits the RIGHT merge-patch shape `chroma_project_set_
 * settings` expects (width+height together, never one alone; `null` for
 * "match"), not the plumbing around it (covered instead by
 * `EditorInspectorPanel.projectSettings.dom.test.tsx`, which proves this
 * same form wired to the real backend commands end to end).
 *
 * Same tier and harness as its neighbours (`ClipInspectorPanel.tabs.dom.
 * test.tsx` etc.): jsdom, the real component mounted via `pointerHarness`'s
 * `mount` (a real, attached DOM via `react-dom/client`), no store involved.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';

import { actSync, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

// `@apelles/ui` pulls in a `@tauri-apps/api` dependency for its scrub-cursor
// gesture (D-271) — stubbed the same defensive way every Inspector DOM test
// in this package already stubs the Tauri bridge, even though this
// component itself never calls `invoke`.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => {
    throw new Error('ProjectSettingsForm.dom.test.tsx: no invoke call expected');
  },
}));

const { ProjectSettingsForm } = await import('./ProjectSettingsForm');
import type { ProjectSettingsValue } from './ProjectSettingsForm';

let mounted: MountedComponent | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function renderForm(settings: ProjectSettingsValue, disabled?: boolean) {
  const onChange = vi.fn();
  mounted = mount(React.createElement(ProjectSettingsForm, { settings, onChange, disabled }));
  await waitFrames(1);
  return onChange;
}

function buttons(name: string): HTMLElement[] {
  return [...(mounted?.container.querySelectorAll('button') ?? [])].filter((b) => b.textContent === name);
}

function button(name: string, index = 0): HTMLElement {
  const hits = buttons(name);
  const el = hits[index];
  if (!el) throw new Error(`no button "${name}" at index ${index} (found ${hits.length})`);
  return el;
}

async function click(el: HTMLElement) {
  actSync(() => el.click());
  await waitFrames(1);
}

describe('ProjectSettingsForm', () => {
  it('defaults to "Match first clip" for both Resolution and Frame Rate when the project has no explicit spec', async () => {
    await renderForm({});
    expect(buttons('Match first clip')).toHaveLength(2); // one per group (Resolution, Frame Rate)
    // Neither group's Preset/Custom sub-controls are shown while on Match.
    expect(buttons('1920×1080 (HD)')).toHaveLength(0);
  });

  it('clicking a resolution preset writes width+height together', async () => {
    const onChange = await renderForm({ width: null, height: null });
    await click(button('Preset', 0));
    await click(button('1080×1920 (vertical)'));
    expect(onChange).toHaveBeenCalledWith({ width: 1080, height: 1920 });
  });

  it('switching Resolution to Custom from Match seeds a real starting size', async () => {
    const onChange = await renderForm({ width: null, height: null });
    await click(button('Custom', 0));
    // Custom mode with no prior number seeds a concrete default rather than
    // leaving the fields with nothing to type into.
    expect(onChange).toHaveBeenCalledWith({ width: 1920, height: 1080 });
  });

  it('"Match first clip" for Resolution clears both fields to null together', async () => {
    const onChange = await renderForm({ width: 1920, height: 1080 });
    await click(button('Match first clip', 0));
    expect(onChange).toHaveBeenCalledWith({ width: null, height: null });
  });

  it('"Match first clip" for Frame Rate clears fps to null, independent of Resolution', async () => {
    const onChange = await renderForm({ width: 1920, height: 1080, fps: 30 });
    await click(button('Match first clip', 1));
    expect(onChange).toHaveBeenCalledWith({ fps: null });
  });

  // No existing test in this package interacts with or asserts on a
  // `Select`'s resolved item list in jsdom — Base UI only mounts
  // `SelectContent`'s items once the popover actually opens, which jsdom's
  // no-layout/no-pointer tier doesn't produce (the same honest limitation
  // this package's other Select-backed rows, e.g. the Fade/EQ curve
  // pickers, already leave untested at this level). What IS worth proving
  // at THIS tier is that the section and its trigger render at all,
  // regardless of the incoming value — the value/onChange WIRING itself
  // (`value={settings.colorSpace ?? 'rec709'}`, `onValueChange={(v) =>
  // onChange({ colorSpace: v })}`) is plain, typed prop-passing with no
  // branch of its own to get wrong.
  it('renders a Colour Space control whatever the incoming value', async () => {
    await renderForm({});
    expect(mounted?.container.textContent).toContain('Colour Space');
    expect(mounted?.container.querySelector('[data-slot="select-trigger"]')).toBeTruthy();

    mounted?.unmount();
    await renderForm({ colorSpace: 'dci-p3' });
    expect(mounted?.container.querySelector('[data-slot="select-trigger"]')).toBeTruthy();
  });

  it('disables every pill when `disabled` is set (e.g. a save in flight)', async () => {
    await renderForm({}, true);
    for (const btn of buttons('Match first clip')) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
