/**
 * ClaudeChatDemo — the living reference for the `deviceframe` + `claudechat`
 * pair (D-258), and the composition the primitives' visual verification
 * renders stills from.
 *
 * It shows both halves of the decoupling on one canvas:
 *   - LEFT: the chat primitive nested inside the device frame as React
 *     children, walking through THREE conversations over the scene via the
 *     `active` step schedule — the welcome screen, a France-visa research
 *     thread, and a calendar thread.
 *   - RIGHT: the SAME chat primitive full-bleed with no phone around it at
 *     all, proving it is not hardwired to the frame; and a bare
 *     `DeviceFrame` with nothing in it, proving the frame is not hardwired
 *     to the chat.
 *
 * The coral ground is the reference screenshot's own background colour
 * (#da7758, sampled), which is also why this demo does not use `design.bg` —
 * the point of the frame is to read the way the reference reads.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { ClaudeChat } from "../primitives/ClaudeChat";
import { DeviceFrame } from "../primitives/DeviceFrame";
import { deviceScreenRect } from "../lib/device";
import { resolveActiveStep } from "../lib/chatLayout";
import type { Conversation } from "../lib/chatLayout";

const REFERENCE_CORAL = "#da7758";

export const DEMO_CONVERSATIONS: Conversation[] = [
  { welcome: "How can I help you this morning?", messages: [] },
  {
    model: "Sonnet 4",
    messages: [
      {
        from: "user",
        sender: "Brooke",
        text: "I'm planning to move to France for work - can you help me plan my move and research visa requirements?",
      },
      {
        from: "assistant",
        text: "I'll help coordinate your move to France. First, let me check your Google Drive for itineraries and travel documents.",
      },
      { kind: "tool", label: "Searched Google Drive", icon: "drive" },
      {
        from: "assistant",
        text: "Next, I'll start my deep dive into French visa requirements, work permit processes, and all the documentation you'll need!",
      },
      {
        kind: "task",
        title: "French work visa research",
        meta: "Research complete · 300 sources · 3m 36s",
        icon: "web",
      },
      { from: "assistant", text: "Your France work visa guide is ready:" },
      {
        kind: "doc",
        title: "Working in France: Comprehensive Visa Guide for 2025",
        subtitle: "Document",
      },
    ],
  },
  {
    model: "Opus 4",
    messages: [
      { from: "user", sender: "Brooke", text: "What does my Thursday look like?" },
      { kind: "tool", label: "Searched Google Calendar", icon: "search" },
      {
        from: "assistant",
        text: "Jenny school drop-off: 8:00 AM\nMarketing Team Standup: 9:30 AM\nPresentation with Brighten Co: 11:00 AM\nMeeting with Sarah: 2:00 PM",
      },
      { kind: "tool", label: "Sources", icon: "doc" },
    ],
  },
];

/** the three-step schedule the demo walks, in seconds */
const SCHEDULE = [
  { at: 0, i: 0 },
  { at: 2.6, i: 1 },
  { at: 11, i: 2 },
];

export const ClaudeChatDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // the demo drives the schedule itself, exactly as `engine/registry.ts`'s
  // `claudechat` adapter does for a manifest layer — same function, so what
  // this composition shows is what a manifest produces.
  const step = resolveActiveStep(SCHEDULE, fps, frame, 0);

  const leftX = width * 0.28;
  const rightX = width * 0.72;
  const cy = height / 2;
  const scale = 0.98;

  const bare = deviceScreenRect({ model: "iphone-15-pro", x: rightX, y: cy, scale });

  return (
    <AbsoluteFill style={{ backgroundColor: REFERENCE_CORAL }}>
      {/* nested: the chat as the frame's children */}
      <DeviceFrame model="iphone-15-pro" x={leftX} y={cy} scale={scale}>
        <ClaudeChat
          conversations={DEMO_CONVERSATIONS}
          conversation={step.i}
          conversationStart={step.since}
          x={0}
          y={0}
          width={deviceScreenRect({ model: "iphone-15-pro", x: 0, y: 0, scale }).width}
          height={deviceScreenRect({ model: "iphone-15-pro", x: 0, y: 0, scale }).height}
          radius={0}
          researchActive
        />
      </DeviceFrame>

      {/* standalone: the same primitive with no phone around it, at the same
          rect the bare frame on the right would have left open */}
      <ClaudeChat
        conversations={DEMO_CONVERSATIONS}
        conversation={step.i}
        conversationStart={step.since}
        x={bare.x}
        y={bare.y}
        width={bare.width}
        height={bare.height}
        radius={bare.radius}
        reveal="fade"
      />
    </AbsoluteFill>
  );
};
