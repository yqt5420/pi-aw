/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionMode, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";

// pi-web (and generic RPC hosts) render widget lines in a wrapping <pre> with no
// terminal-width concept, so truncation to a fixed pane width is meaningless. A
// generous width keeps the TUI-style truncate path effectively a no-op and lets
// the web host wrap naturally. The row budget (maxWidgetLines) still applies,
// collapsing deep lists into a "+N more" summary like the TUI overlay.
const MAX_WEB_WIDGET_WIDTH = 200;

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private collapsed = false;
	// The bound host mode: "tui" uses the component-factory widget (render + live
	// requestRender); every other mode (pi-web drops in as "rpc") only supports
	// string-array widgets, sent fire-and-forget on each update.
	private mode: ExtensionMode | undefined;
	// Last plain lines sent to a non-TUI host, so identical refreshes don't
	// re-emit a redundant setWidget request.
	private lastWebLines: string[] | undefined;

	setUICtx(ctx: ExtensionUIContext, mode?: ExtensionMode): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx || mode !== this.mode) {
			this.uiCtx = ctx;
			this.mode = mode ?? "tui";
			this.widgetRegistered = false;
			this.tui = undefined;
			this.lastWebLines = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);
		// 行为 B：面板只在存在可执行任务（pending / in_progress）时出现。全部完成、
		// 或被删除/清空时，整个面板隐藏（deleted/completed 都不算可执行）。
		const hasActionable = snapshot.tasks.some((t) => t.status === "in_progress" || t.status === "pending");

		if (visible.length === 0 || !hasActionable) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
				this.lastWebLines = undefined;
			}
			return;
		}

		// Non-TUI host (pi-web / RPC):
		if (this.mode !== "tui") {
			const lines = this.renderWidget(this.uiCtx.theme, MAX_WEB_WIDGET_WIDTH);
			if (!this.widgetRegistered || !arrayEquals(this.lastWebLines, lines)) {
				this.uiCtx.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
				this.lastWebLines = lines;
				this.widgetRegistered = true;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		// 完成项与显隐均纯从 store 派生，无需任何内存态重置——reload/压缩后始终一致。
	}

	hideCompletedTasksFromPreviousTurn(): void {
		// 同理：completed 任务在渲染时直接过滤，无“跨轮隐藏”状态机。
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private getSnapshot() {
		const state = getRenderState();
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		// 显示 pending / in_progress / completed，仅隐藏 deleted。completed 由
		// formatOverlayTaskLine 渲染为 ✓ + 删除线（TUI；web 因纯文本 <pre> 只能显示 ✓）。
		// 面板整体显隐改由 update() 的 hasActionable 决定，见下。
		return snapshot.tasks.filter((task) => task.status !== "deleted");
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		// 计数/hasActive/showIds 基于全量（含 completed），让标题的 (完成/总数) 与
		// /todos、list 权威态一致——overlay 只隐藏 completed 行，不扭曲统计。
		const full = { tasks: snapshot.tasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(full);
		const hasActive = selectHasActive(full);
		const showIds = selectShowTaskIds(full);
		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		// Collapsed view: just the heading + a dim "└─" expand hint, then the
		// trailing spacer. Short-circuit before the budget math and the completed-
		// display tracking — nothing is shown to track, and skipping the tracking
		// when nothing is rendered is correctness, not optimization. The hint splices
		// the resolved key into the {key} placeholder (per-render, like the row
		// budget); a config edit needs /reload to re-bind the actual shortcut. The
		// "off" sentinel is reachable here mid-session (config edited after the
		// shortcut was bound and the overlay collapsed) — render a static collapsed
		// label instead of splicing the sentinel into the placeholder.
		if (this.collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
		}

		const lines: string[] = [heading];
		// Budget for content rows (heading + tasks/summary). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		const layout = selectOverlayLayout(overlayState, getMaxWidgetLines() - 1);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.mode = undefined;
		this.lastWebLines = undefined;
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}

/** Shallow array equality for skipping redundant web widget refreshes. */
function arrayEquals(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
