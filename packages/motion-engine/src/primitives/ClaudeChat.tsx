/**
 * ClaudeChat — the Claude mobile app's conversation UI as a motion primitive
 * (D-258).
 *
 * What it is: a real depiction of the app screen — header with a back control
 * and a model chip, a message thread of user bubbles / serif assistant prose /
 * tool chips / task cards / document cards, a welcome state with the sunburst
 * mark, and the input bar with its icon row. Every colour, proportion and
 * typeface split here was sampled from the owner's own reference screenshot
 * of the shipping iOS app (see D-258 for the sampled values), not guessed.
 *
 * The feature it exists for is MULTIPLE conversations animated over one
 * scene: `conversations` holds as many threads as you like, and which one is
 * on screen at a given time is driven by the manifest's EXISTING `active`
 * step schedule — the same `[{at, i}]` field `layers` and `layerstack`
 * already use — rather than a second, parallel scheduling mechanism invented
 * for this primitive. Switching conversations replays the new thread's
 * messages from its own start, so a scene can walk through several complete
 * conversations end to end.
 *
 * What it does NOT do: it is not a phone. It draws no bezel, no notch and no
 * chassis, and it does not require `DeviceFrame` — it renders full-bleed just
 * as happily as it renders inside a phone's glass. The two primitives agree
 * only on a rectangle (`../lib/device.ts`'s `deviceScreenRect`), which is
 * what keeps them independently placeable, selectable and keyframable. It
 * also does no DOM text measurement: the thread's layout is computed
 * arithmetically in `../lib/chatLayout.ts` so a render is deterministic.
 *
 *   <ClaudeChat conversations={[{messages:[{from:"user",text:"…"}]}]}
 *               active={[{at:0,i:0},{at:6,i:1}]} />
 *
 * `data-motion-box` (D-155) marks the screen rect; `data-motion-item-index`
 * (D-182) marks each message block, so the visual builder can select one
 * message rather than the whole layer.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { inAt, pop } from "../lib/draw";
import { deviceScreenRect } from "../lib/device";
import {
  DEFAULT_METRICS,
  layoutThread,
  revealFrames,
  scrollOffset,
  type ChatMessage,
  type Conversation,
  type ThreadMetrics,
} from "../lib/chatLayout";
import {
  BackIcon,
  ChevronDownIcon,
  MicIcon,
  NewChatIcon,
  PlusIcon,
  SearchIcon,
  SlidersIcon,
  Sunburst,
  PagePreview,
  toolIcon,
} from "./claudeChatGlyphs";

/** The metrics above are authored against the iPhone 15 Pro's glass width
 *  (393pt body − 2×12pt bezel). Everything internal scales off this, so the
 *  primitive reads correctly at a phone's size and full-bleed at 1920 alike. */
const BASE_SCREEN_W = 369;

/** Colours sampled from the reference screenshot (D-258). Exposed as props so
 *  a dark-mode or brand variant is a prop change, not a fork. */
const PALETTE = {
  bg: "#f8f7f3",
  ink: "#262523",
  muted: "#83817c",
  accent: "#da7758",
  bubbleBg: "#f1eee7",
  cardBg: "#f5f4f0",
  border: "#e4e2dc",
  inputBg: "#fbfbfb",
  activeChip: "#dce8fb",
  activeChipInk: "#3b6fd4",
} as const;

/** The two faces the app pairs: a serif for assistant prose, headings and the
 *  word "Claude"; a humanist sans for UI chrome, user bubbles and card
 *  labels. Defaults are system faces that ship on the target platform, so a
 *  render never waits on a webfont (which would make layout frame-dependent —
 *  see `chatLayout.ts` on why measurement is arithmetic here). */
const FONT_SERIF = '"Tiempos Text", "Copernicus", Georgia, "Times New Roman", serif';
const FONT_SANS =
  '"Styrene B", "Avenir Next", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif';

export type RevealPreset = "fade" | "slide" | "pop" | "type";

export const ClaudeChat: React.FC<{
  /** the threads this layer can show. Which one is on screen at a given frame
   *  comes from `active` (resolved upstream in `engine/registry.ts`). */
  conversations?: Conversation[];
  /** single-thread convenience — equivalent to `conversations:[{messages}]` */
  messages?: ChatMessage[];
  /** resolved by the registry from the manifest's `active` schedule */
  conversation?: number;
  /** the frame the active conversation took over on; message reveals are
   *  relative to it, so a switch replays the new thread from its own zero */
  conversationStart?: number;

  /** screen rect in world px. Omit and the layer sizes itself to an
   *  iPhone 15 Pro's glass, centred on the canvas — i.e. exactly the rect
   *  `DeviceFrame` with the same defaults leaves open. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radius?: number;

  /** entrance of the whole screen, in frames */
  start?: number;
  /** frames between two consecutive message reveals */
  stagger?: number;
  /** length of one message's reveal animation, in frames */
  revealFrames?: number;
  reveal?: RevealPreset;
  /** cross-fade when switching conversations, in frames */
  switchFrames?: number;
  /** show the three-dot typing indicator before each assistant message */
  typing?: boolean;
  typingFrames?: number;

  /** chrome toggles */
  header?: boolean;
  inputBar?: boolean;
  statusBar?: boolean;
  /** header title and model chip; a conversation may override either */
  title?: string;
  model?: string;
  /** shown centred when the active conversation has no messages */
  welcome?: string;
  placeholder?: string;
  /** highlight the research toggle in the input row, as the reference does */
  researchActive?: boolean;

  bg?: string;
  ink?: string;
  muted?: string;
  accent?: string;
  bubbleBg?: string;
  cardBg?: string;
  border?: string;
  inputBg?: string;
  fontSerif?: string;
  fontSans?: string;
}> = ({
  conversations,
  messages,
  conversation = 0,
  conversationStart = 0,
  x,
  y,
  width,
  height,
  radius,
  start = 0,
  stagger = 26,
  revealFrames: revealLen = 14,
  reveal = "slide",
  switchFrames = 16,
  typing = true,
  typingFrames = 14,
  header = true,
  inputBar = true,
  statusBar = true,
  title = "Claude",
  model = "Sonnet 4",
  welcome = "How can I help you this morning?",
  placeholder,
  researchActive = false,
  bg = PALETTE.bg,
  ink = PALETTE.ink,
  muted = PALETTE.muted,
  accent = PALETTE.accent,
  bubbleBg = PALETTE.bubbleBg,
  cardBg = PALETTE.cardBg,
  border = PALETTE.border,
  inputBg = PALETTE.inputBg,
  fontSerif = FONT_SERIF,
  fontSans = FONT_SANS,
}) => {
  const frame = useCurrentFrame();
  const { width: cw, height: ch, fps } = useVideoConfig();

  // default to exactly the glass DeviceFrame's own defaults leave open
  const glass = deviceScreenRect({ model: "iphone-15-pro", x: cw / 2, y: ch / 2, scale: 1 });
  const W = width ?? glass.width;
  const H = height ?? glass.height;
  const X = x ?? glass.x;
  const Y = y ?? glass.y;
  const R = radius ?? glass.radius;

  const k = W / BASE_SCREEN_W;
  const pad = 20 * k;

  const threads: Conversation[] =
    conversations && conversations.length > 0
      ? conversations
      : [{ messages: messages ?? [] }];
  const idx = Math.min(Math.max(conversation < 0 ? 0 : conversation, 0), threads.length - 1);
  const thread = threads[idx] ?? { messages: [] };
  const msgs = thread.messages ?? [];

  const metrics: ThreadMetrics = {
    ...DEFAULT_METRICS,
    contentWidth: W - pad * 2,
    bodySize: DEFAULT_METRICS.bodySize * k,
    bodyLineHeight: DEFAULT_METRICS.bodyLineHeight * k,
    bubbleSize: DEFAULT_METRICS.bubbleSize * k,
    bubbleLineHeight: DEFAULT_METRICS.bubbleLineHeight * k,
    bubblePadX: DEFAULT_METRICS.bubblePadX * k,
    bubblePadY: DEFAULT_METRICS.bubblePadY * k,
    senderHeight: DEFAULT_METRICS.senderHeight * k,
    toolHeight: DEFAULT_METRICS.toolHeight * k,
    taskHeight: DEFAULT_METRICS.taskHeight * k,
    docHeight: DEFAULT_METRICS.docHeight * k,
    gap: DEFAULT_METRICS.gap * k,
  };

  const statusH = statusBar ? 54 * k : 0;
  const headerH = header ? 44 * k : 0;
  const inputH = inputBar ? 104 * k : 0;
  const viewTop = statusH + headerH;
  const viewH = Math.max(0, H - viewTop - inputH);

  // reveals are relative to whenever THIS conversation came on screen
  const base = Math.max(start, conversationStart);
  const layout = layoutThread(msgs, metrics);
  const reveals = revealFrames(msgs, fps, stagger, base);
  const scroll = scrollOffset(layout, reveals, frame, viewH - pad, revealLen);

  const appear = inAt(frame, start, start + 12);
  // the whole thread cross-fades on a conversation switch (not on the first
  // conversation, whose `since` is 0 and which uses the entrance above)
  const switched = conversationStart > 0;
  const swap = switched ? inAt(frame, conversationStart, conversationStart + switchFrames) : 1;

  const empty = msgs.length === 0;
  const revealedCount = reveals.filter((f) => frame >= f).length;

  return (
    <div
      data-motion-box
      style={{
        position: "absolute",
        left: X,
        top: Y,
        width: W,
        height: H,
        borderRadius: R,
        overflow: "hidden",
        background: bg,
        opacity: appear,
        fontFamily: fontSans,
        color: ink,
      }}
    >
      {statusBar && <StatusBar k={k} ink={ink} width={W} />}

      {header && (
        <Header
          k={k}
          width={W}
          top={statusH}
          height={headerH}
          ink={ink}
          muted={muted}
          title={thread.title ?? title}
          model={thread.model ?? model}
          fontSerif={fontSerif}
        />
      )}

      {/* the thread viewport */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: viewTop,
          width: W,
          height: viewH,
          overflow: "hidden",
          opacity: swap,
        }}
      >
        {empty ? (
          <Welcome
            k={k}
            width={W}
            height={viewH}
            text={thread.welcome ?? welcome}
            accent={accent}
            ink={ink}
            fontSerif={fontSerif}
            frame={frame}
            start={base}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              left: pad,
              top: pad - scroll,
              width: metrics.contentWidth,
              transform: `translateY(${(1 - swap) * 18 * k}px)`,
            }}
          >
            {msgs.map((m, i) => (
              <MessageBlock
                key={`${idx}:${i}`}
                m={m}
                index={i}
                box={layout.blocks[i]}
                at={reveals[i]}
                frame={frame}
                fps={fps}
                revealLen={revealLen}
                preset={reveal}
                mt={metrics}
                k={k}
                ink={ink}
                muted={muted}
                bubbleBg={bubbleBg}
                cardBg={cardBg}
                border={border}
                fontSerif={fontSerif}
                fontSans={fontSans}
              />
            ))}

            {typing && revealedCount < msgs.length && (
              <TypingDots
                k={k}
                muted={muted}
                top={
                  revealedCount === 0
                    ? 0
                    : layout.blocks[revealedCount - 1].top +
                      layout.blocks[revealedCount - 1].height +
                      metrics.gap
                }
                frame={frame}
                from={reveals[revealedCount] - typingFrames}
                to={reveals[revealedCount]}
              />
            )}
          </div>
        )}
      </div>

      {inputBar && (
        <InputBar
          k={k}
          width={W}
          height={inputH}
          ink={ink}
          muted={muted}
          border={border}
          inputBg={inputBg}
          placeholder={placeholder ?? (empty ? "Chat with Claude" : "Reply to Claude")}
          researchActive={researchActive}
          voiceButton={empty}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------- chrome

const StatusBar: React.FC<{ k: number; ink: string; width: number }> = ({ k, ink, width }) => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      width,
      height: 54 * k,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: `0 ${26 * k}px`,
      fontSize: 13 * k,
      fontWeight: 600,
      color: ink,
      letterSpacing: 0.2 * k,
    }}
  >
    <span style={{ marginTop: 6 * k }}>9:41</span>
    <span style={{ marginTop: 6 * k, display: "flex", alignItems: "center", gap: 4 * k }}>
      <Bars k={k} color={ink} />
      <BatteryMark k={k} color={ink} />
    </span>
  </div>
);

const Bars: React.FC<{ k: number; color: string }> = ({ k, color }) => (
  <svg width={16 * k} height={11 * k} viewBox="0 0 16 11" aria-hidden>
    {[0, 1, 2, 3].map((i) => (
      <rect
        key={i}
        x={i * 4}
        y={8 - i * 2.4}
        width={2.6}
        height={3 + i * 2.4}
        rx={0.8}
        fill={color}
      />
    ))}
  </svg>
);

const BatteryMark: React.FC<{ k: number; color: string }> = ({ k, color }) => (
  <svg width={22 * k} height={11 * k} viewBox="0 0 22 11" aria-hidden>
    <rect x="0.6" y="0.6" width="18" height="9.8" rx="2.6" fill="none" stroke={color} opacity="0.4" />
    <rect x="2" y="2" width="14" height="7" rx="1.6" fill={color} />
    <path d="M20.2 4v3a2 2 0 0 0 0-3Z" fill={color} opacity="0.5" />
  </svg>
);

const Header: React.FC<{
  k: number;
  width: number;
  top: number;
  height: number;
  ink: string;
  muted: string;
  title: string;
  model: string;
  fontSerif: string;
}> = ({ k, width, top, height, ink, muted, title, model, fontSerif }) => (
  <div
    style={{
      position: "absolute",
      top,
      left: 0,
      width,
      height,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: `0 ${16 * k}px`,
    }}
  >
    <span style={{ display: "flex", alignItems: "center", gap: 2 * k, fontSize: 16 * k, fontWeight: 600 }}>
      <BackIcon size={19 * k} color={ink} />
      Back
    </span>
    <span style={{ display: "flex", alignItems: "center", gap: 5 * k, fontFamily: fontSerif }}>
      <span style={{ fontSize: 17 * k, fontWeight: 700, color: ink }}>{title}</span>
      <span style={{ fontSize: 17 * k, color: muted }}>{model}</span>
      <ChevronDownIcon size={13 * k} color={muted} />
    </span>
    <NewChatIcon size={20 * k} color={muted} />
  </div>
);

const Welcome: React.FC<{
  k: number;
  width: number;
  height: number;
  text: string;
  accent: string;
  ink: string;
  fontSerif: string;
  frame: number;
  start: number;
}> = ({ k, width, height, text, accent, ink, fontSerif, frame, start }) => {
  const a = inAt(frame, start + 4, start + 22);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16 * k,
        opacity: a,
        transform: `translateY(${(1 - a) * 10 * k}px)`,
        padding: `0 ${34 * k}px`,
        boxSizing: "border-box",
      }}
    >
      <Sunburst size={34 * k} color={accent} />
      <div
        style={{
          fontFamily: fontSerif,
          fontSize: 27 * k,
          lineHeight: 1.24,
          textAlign: "center",
          color: ink,
        }}
      >
        {text}
      </div>
    </div>
  );
};

const InputBar: React.FC<{
  k: number;
  width: number;
  height: number;
  ink: string;
  muted: string;
  border: string;
  inputBg: string;
  placeholder: string;
  researchActive: boolean;
  voiceButton: boolean;
}> = ({ k, width, height, ink, muted, border, inputBg, placeholder, researchActive, voiceButton }) => {
  const btn = 30 * k;
  const circle = (active: boolean): React.CSSProperties => ({
    width: btn,
    height: btn,
    borderRadius: btn / 2,
    border: `${1.1 * k}px solid ${active ? "transparent" : border}`,
    background: active ? PALETTE.activeChip : "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        width,
        height,
        background: inputBg,
        borderRadius: `${22 * k}px ${22 * k}px 0 0`,
        boxShadow: `0 ${-1 * k}px 0 ${border}`,
        padding: `${16 * k}px ${18 * k}px 0`,
        boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 15.5 * k, color: muted }}>{placeholder}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10 * k,
          marginTop: 14 * k,
        }}
      >
        <span style={circle(false)}>
          <PlusIcon size={16 * k} color={ink} />
        </span>
        <span style={circle(false)}>
          <SlidersIcon size={16 * k} color={ink} />
        </span>
        <span style={circle(researchActive)}>
          <SearchIcon
            size={16 * k}
            color={researchActive ? PALETTE.activeChipInk : ink}
          />
        </span>
        <span style={{ flex: 1 }} />
        <MicIcon size={18 * k} color={ink} />
        {voiceButton && (
          <span
            style={{
              width: btn,
              height: btn,
              borderRadius: btn / 2,
              background: "#1b1a18",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 1.6 * k,
            }}
          >
            {[0.42, 0.72, 1, 0.66, 0.36].map((h, i) => (
              <span
                key={i}
                style={{
                  width: 1.7 * k,
                  height: 13 * k * h,
                  borderRadius: 1 * k,
                  background: "#fbfbfb",
                }}
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
};

// --------------------------------------------------------------- thread

const TypingDots: React.FC<{
  k: number;
  muted: string;
  top: number;
  frame: number;
  from: number;
  to: number;
}> = ({ k, muted, top, frame, from, to }) => {
  if (frame < from || frame >= to) return null;
  const a = inAt(frame, from, from + 5);
  return (
    <div
      style={{
        position: "absolute",
        top,
        left: 0,
        display: "flex",
        alignItems: "center",
        gap: 5 * k,
        height: 24 * k,
        opacity: a,
      }}
    >
      {[0, 1, 2].map((i) => {
        // deterministic 18-frame cycle, phase-offset per dot
        const p = ((frame - from + i * 6) % 18) / 18;
        const lift = Math.sin(p * Math.PI * 2) * 2.2 * k;
        return (
          <span
            key={i}
            style={{
              width: 6 * k,
              height: 6 * k,
              borderRadius: 3 * k,
              background: muted,
              opacity: 0.55 + 0.35 * Math.sin(p * Math.PI * 2),
              transform: `translateY(${-lift}px)`,
            }}
          />
        );
      })}
    </div>
  );
};

const MessageBlock: React.FC<{
  m: ChatMessage;
  index: number;
  box: { top: number; height: number } | undefined;
  at: number;
  frame: number;
  fps: number;
  revealLen: number;
  preset: RevealPreset;
  mt: ThreadMetrics;
  k: number;
  ink: string;
  muted: string;
  bubbleBg: string;
  cardBg: string;
  border: string;
  fontSerif: string;
  fontSans: string;
}> = ({
  m,
  index,
  box,
  at,
  frame,
  fps,
  revealLen,
  preset,
  mt,
  k,
  ink,
  muted,
  bubbleBg,
  cardBg,
  border,
  fontSerif,
  fontSans,
}) => {
  if (!box || frame < at) return null;
  const t = inAt(frame, at, at + revealLen);
  const s = preset === "pop" ? pop(frame, fps, at) : 1;
  const dy = preset === "slide" ? (1 - t) * 14 * k : 0;
  const opacity = preset === "type" ? 1 : t;

  const kind = m.kind ?? "text";
  const typed =
    preset === "type" && kind === "text"
      ? (m.text ?? "").slice(
          0,
          Math.max(1, Math.ceil((m.text ?? "").length * inAt(frame, at, at + revealLen * 2.2))),
        )
      : m.text ?? "";

  return (
    <div
      data-motion-item-index={index}
      style={{
        position: "absolute",
        top: box.top,
        left: 0,
        width: mt.contentWidth,
        height: box.height,
        opacity,
        transform: `translateY(${dy}px) scale(${preset === "pop" ? 0.96 + 0.04 * s : 1})`,
        transformOrigin: m.from === "user" ? "100% 50%" : "0% 50%",
      }}
    >
      {kind === "text" && m.from === "user" && (
        <>
          {m.sender && (
            <div
              style={{
                height: mt.senderHeight,
                fontSize: 12.5 * k,
                fontWeight: 700,
                color: ink,
                fontFamily: fontSans,
              }}
            >
              {m.sender}
            </div>
          )}
          <div
            style={{
              background: bubbleBg,
              borderRadius: 14 * k,
              padding: `${mt.bubblePadY}px ${mt.bubblePadX}px`,
              fontFamily: fontSans,
              fontSize: mt.bubbleSize,
              lineHeight: `${mt.bubbleLineHeight}px`,
              color: ink,
              // `wrapLines` counts an explicit \n as a hard break, so the box
              // has to draw it as one too or measured and real height diverge
              whiteSpace: "pre-wrap",
            }}
          >
            {typed}
          </div>
        </>
      )}

      {kind === "text" && m.from !== "user" && (
        <div
          style={{
            fontFamily: fontSerif,
            fontSize: mt.bodySize,
            lineHeight: `${mt.bodyLineHeight}px`,
            color: ink,
            whiteSpace: "pre-wrap",
          }}
        >
          {typed}
        </div>
      )}

      {kind === "tool" && (
        <div
          style={{
            height: mt.toolHeight,
            border: `${1.1 * k}px solid ${border}`,
            borderRadius: 12 * k,
            display: "flex",
            alignItems: "center",
            gap: 12 * k,
            padding: `0 ${14 * k}px`,
            boxSizing: "border-box",
            fontFamily: fontSans,
            fontSize: 14.5 * k,
            color: ink,
          }}
        >
          {toolIcon(m.icon, 20 * k, muted)}
          <span>{m.label ?? m.title ?? ""}</span>
        </div>
      )}

      {kind === "task" && (
        <div
          style={{
            height: mt.taskHeight,
            border: `${1.1 * k}px solid ${border}`,
            borderRadius: 12 * k,
            padding: `${10 * k}px ${14 * k}px`,
            boxSizing: "border-box",
            fontFamily: fontSans,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 6 * k,
          }}
        >
          <div style={{ fontSize: 14 * k, fontWeight: 600, color: ink }}>{m.title ?? ""}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 * k }}>
            {toolIcon(m.icon, 14 * k, muted)}
            <span style={{ fontSize: 12.5 * k, color: muted }}>{m.meta ?? ""}</span>
          </div>
        </div>
      )}

      {kind === "doc" && (
        <div
          style={{
            height: mt.docHeight,
            background: cardBg,
            border: `${1.1 * k}px solid ${border}`,
            borderRadius: 12 * k,
            padding: `${12 * k}px ${14 * k}px`,
            boxSizing: "border-box",
            fontFamily: fontSans,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12 * k,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14 * k, fontWeight: 600, color: ink, lineHeight: 1.32 }}>
              {m.title ?? ""}
            </div>
            <div style={{ fontSize: 12.5 * k, color: muted, marginTop: 5 * k }}>
              {m.subtitle ?? "Document"}
            </div>
          </div>
          <div
            style={{
              width: 46 * k,
              height: 58 * k,
              background: "#fdfdfb",
              border: `${1 * k}px solid ${border}`,
              borderRadius: 3 * k,
              overflow: "hidden",
            }}
          >
            <PagePreview width={46 * k} height={58 * k} color={muted} />
          </div>
        </div>
      )}
    </div>
  );
};
