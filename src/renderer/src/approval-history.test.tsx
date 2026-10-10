import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { AppAccessGate } from "./AppView";
import { AppProviders } from "./app-providers";
import {
  AGENTS,
  browserTab,
  confirmOnboardingModel,
  emitAgentEvent,
  installOpenbotStub,
  testConversationPage,
  testServer,
} from "./app-test-harness";
import { useConversation } from "./features/conversation/conversation-context";
import { useTurns } from "./turns";

function Probe() {
  const agents = useTurns();
  const conversation = useConversation();
  return (
    <output aria-label="Gateway state">
      {JSON.stringify({
        loaded: conversation.conversations.chief?.loaded === true,
        prompt: agents.pendingPrompts().chief?.type === "prompt",
        approval: agents.pendingApprovals().chief !== undefined,
      })}
    </output>
  );
}

function ask(kind: "approval" | "mcp", agentId = "chief", requestId: number = kind === "approval" ? 14 : 15) {
  if (kind === "approval")
    emitAgentEvent?.({
      type: "approval",
      approval: {
        requestId,
        agentId,
        threadId: `thread-${agentId}`,
        turnId: "turn-1",
        kind: "permissions",
        command: null,
        cwd: null,
        reason: `Synthetic gateway review ${requestId}`,
        grantRoot: null,
        permissions: { fileSystem: { read: ["/synthetic/project"], write: [] }, network: true },
      },
    });
  else
    emitAgentEvent?.({
      type: "prompt",
      requestId,
      agentId,
      threadId: `thread-${agentId}`,
      turnId: "turn-1",
      questions: [
        {
          id: "mcp-elicitation-decision",
          header: "Computer Use",
          question: "Allow the synthetic Computer Use tool?",
          isSecret: false,
          options: [
            { label: "Allow once", description: "" },
            { label: "Don't allow", description: "" },
          ],
        },
      ],
    });
}

beforeEach(async () => {
  installOpenbotStub();
  // Await this existing lazy module before disposal so its unrelated background import
  // cannot obscure the result. The fixture uses no installed account or provider.
  await import("./features/settings/SettingsModal");
});

it.each(["approval", "mcp"] as const)("normal loaded history displays and answers %s", async (kind) => {
  render(() => (
    <AppProviders>
      <AppAccessGate />
      <Probe />
    </AppProviders>
  ));
  await screen.findByRole("heading", { name: "Chief" });
  await confirmOnboardingModel();
  await waitFor(() => expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":true'));
  ask(kind);
  if (kind === "approval") {
    await screen.findByText("Grant permissions");
    await fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToApproval).toHaveBeenCalledWith({ requestId: 14, decision: "decline" }),
    );
  } else {
    await screen.findByText("Allow the synthetic Computer Use tool?");
    expect(screen.getByText("Don't allow")).toBeInTheDocument();
  }
});

it.each(["approval", "mcp"] as const)("shows %s while a history read is pending", async (kind) => {
  let release: (page: ReturnType<typeof testConversationPage>) => void = () => {
    throw new Error("Read not started");
  };
  const pending = new Promise<ReturnType<typeof testConversationPage>>((resolve) => {
    release = resolve;
  });
  vi.mocked(window.openbot.agent.readConversationPage).mockReturnValue(pending);
  render(() => (
    <AppProviders>
      <AppAccessGate />
      <Probe />
    </AppProviders>
  ));
  try {
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(window.openbot.agent.readConversationPage).toHaveBeenCalled());
    ask(kind);
    await waitFor(() =>
      expect(screen.getByLabelText("Gateway state")).toHaveTextContent(
        `"${kind === "mcp" ? "prompt" : "approval"}":true`,
      ),
    );
    expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
    // User-visible requirement: receiving an approval must not depend on completing history.
    expect(
      screen.queryByText(kind === "approval" ? "Grant permissions" : "Allow the synthetic Computer Use tool?"),
    ).toBeInTheDocument();
  } finally {
    release(testConversationPage("chief", []));
    await waitFor(() => expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":true'));
    await screen.findByText(kind === "approval" ? "Grant permissions" : "Allow the synthetic Computer Use tool?");
  }
});

it.each(["approval", "mcp"] as const)("shows %s when the initial history read failed", async (kind) => {
  vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValue(new Error("Synthetic history unavailable"));
  render(() => (
    <AppProviders>
      <AppAccessGate />
      <Probe />
    </AppProviders>
  ));
  await screen.findByRole("heading", { name: "Chief" });
  await confirmOnboardingModel();
  await screen.findByText("The conversation could not load. Try again.");
  ask(kind);
  await waitFor(() =>
    expect(screen.getByLabelText("Gateway state")).toHaveTextContent(
      `"${kind === "mcp" ? "prompt" : "approval"}":true`,
    ),
  );
  expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
  expect(
    screen.queryByText(kind === "approval" ? "Grant permissions" : "Allow the synthetic Computer Use tool?"),
  ).toBeInTheDocument();
});

it.each(["approval", "mcp"] as const)("restores %s from a runtime snapshot before history arrives", async (kind) => {
  let release: (page: ReturnType<typeof testConversationPage>) => void = () => {
    throw new Error("Read not started");
  };
  const pending = new Promise<ReturnType<typeof testConversationPage>>((resolve) => {
    release = resolve;
  });
  vi.mocked(window.openbot.agent.readConversationPage).mockReturnValue(pending);
  render(() => (
    <AppProviders>
      <AppAccessGate />
      <Probe />
    </AppProviders>
  ));
  try {
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(window.openbot.agent.readConversationPage).toHaveBeenCalled());
    const approval = {
      requestId: 14,
      agentId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      kind: "permissions" as const,
      command: null,
      cwd: null,
      reason: "Synthetic gateway review",
      grantRoot: null,
      truncated: false,
      permissions: { fileSystem: { read: ["/synthetic/project"], write: [] }, network: true },
    };
    const prompt = {
      requestId: 15,
      agentId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      questions: [
        {
          id: "mcp-elicitation-decision",
          header: "Computer Use",
          question: "Allow the synthetic Computer Use tool?",
          isSecret: false,
          options: [
            { label: "Allow once", description: "" },
            { label: "Don't allow", description: "" },
          ],
        },
      ],
    };
    emitAgentEvent?.({
      type: "runtime-snapshot",
      snapshot: {
        agents: [],
        activeTurns: [{ agentId: "chief", threadId: "thread-chief", turnId: "turn-1" }],
        failedTurns: [],
        latestMessages: [],
        attentionComplete: true,
        pendingApprovals: kind === "approval" ? [approval] : [],
        pendingPrompts: kind === "mcp" ? [prompt] : [],
        pendingBrowserTakeovers: [],
        work: [],
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Gateway state")).toHaveTextContent(
        `"${kind === "mcp" ? "prompt" : "approval"}":true`,
      ),
    );
    expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
    expect(
      screen.queryByText(kind === "approval" ? "Grant permissions" : "Allow the synthetic Computer Use tool?"),
    ).toBeInTheDocument();
    await reply(kind);
    const invoke = kind === "approval" ? window.openbot.agent.respondToApproval : window.openbot.agent.respondToPrompt;
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(vi.mocked(invoke).mock.calls[0]?.[0]).toEqual(
      kind === "approval"
        ? { requestId: 14, decision: "decline" }
        : { requestId: 15, answers: { "mcp-elicitation-decision": ["Don't allow"] } },
    );
    expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
  } finally {
    release(testConversationPage("chief", []));
    await waitFor(() => expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":true'));
  }
});

function holdHistory() {
  let release!: (page: ReturnType<typeof testConversationPage>) => void;
  const page = new Promise<ReturnType<typeof testConversationPage>>((resolve) => {
    release = resolve;
  });
  vi.mocked(window.openbot.agent.readConversationPage).mockReturnValue(page);
  return () => release(testConversationPage("chief", []));
}

async function mountGateway() {
  render(() => (
    <AppProviders>
      <AppAccessGate />
      <Probe />
    </AppProviders>
  ));
  await screen.findByRole("heading", { name: "Chief" });
  await confirmOnboardingModel();
  await waitFor(() => expect(window.openbot.agent.readConversationPage).toHaveBeenCalled());
}

async function reply(kind: "approval" | "mcp") {
  if (kind === "approval") await fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  else await fireEvent.click(await screen.findByRole("radio", { name: /Don.t allow/ }));
}

it.each(["approval", "mcp"] as const)(
  "answers the original %s once while history is pending and keeps its mount on load",
  async (kind) => {
    const releasePage = holdHistory();
    let releaseResponse!: () => void;
    const response = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const invoke =
      kind === "approval"
        ? vi.mocked(window.openbot.agent.respondToApproval)
        : vi.mocked(window.openbot.agent.respondToPrompt);
    invoke.mockReturnValue(response);
    await mountGateway();
    try {
      ask(kind);
      const title = await screen.findByText(
        kind === "approval" ? "Grant permissions" : "Allow the synthetic Computer Use tool?",
      );
      await reply(kind);
      await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
      expect(invoke.mock.calls[0]?.[0]).toEqual(
        kind === "approval"
          ? { requestId: 14, decision: "decline" }
          : {
              requestId: 15,
              answers: { "mcp-elicitation-decision": ["Don't allow"] },
            },
      );
      expect(
        kind === "approval"
          ? screen.getByRole("button", { name: "Sending…" })
          : screen.getByRole("radio", { name: /Don.t allow/ }),
      ).toBeDisabled();
      releasePage();
      await waitFor(() => expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":true'));
      expect(screen.getByText(title.textContent ?? "")).toBe(title);
      expect(
        kind === "approval"
          ? screen.getByRole("button", { name: "Sending…" })
          : screen.getByRole("radio", { name: /Don.t allow/ }),
      ).toBeDisabled();
      expect(invoke).toHaveBeenCalledOnce();
      releaseResponse();
      if (kind === "mcp") {
        await screen.findByRole("region", { name: "Answers sent" });
        expect(
          screen.queryByRole("textbox", { name: "Custom answer for: Allow the synthetic Computer Use tool?" }),
        ).not.toBeInTheDocument();
        // The UI shows the submitted result before the host clears its retained pending record.
        emitAgentEvent?.({ type: "agent-input-resolved", kind: "prompt", requestId: 15, agentId: "chief" });
      }
      await waitFor(() =>
        expect(screen.getByLabelText("Gateway state")).toHaveTextContent(
          kind === "approval" ? '"approval":false' : '"prompt":false',
        ),
      );
    } finally {
      releasePage();
      releaseResponse();
    }
  },
);

it.each(["approval", "mcp"] as const)("can retry a failed %s answer without completing history", async (kind) => {
  vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValue(new Error("Synthetic history unavailable"));
  const invoke =
    kind === "approval"
      ? vi.mocked(window.openbot.agent.respondToApproval)
      : vi.mocked(window.openbot.agent.respondToPrompt);
  invoke.mockRejectedValueOnce(new Error("Synthetic answer unavailable"));
  await mountGateway();
  await screen.findByText("The conversation could not load. Try again.");
  ask(kind);
  await reply(kind);
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      kind === "approval"
        ? screen.getByRole("button", { name: "Deny" })
        : screen.getByRole("radio", { name: /Don.t allow/ }),
    ).toBeEnabled(),
  );
  await reply(kind);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
  if (kind === "mcp") {
    await screen.findByRole("region", { name: "Answers sent" });
    expect(
      screen.queryByRole("textbox", { name: "Custom answer for: Allow the synthetic Computer Use tool?" }),
    ).not.toBeInTheDocument();
    // The UI shows the submitted result before the host clears its retained pending record.
    emitAgentEvent?.({ type: "agent-input-resolved", kind: "prompt", requestId: 15, agentId: "chief" });
  }
  await waitFor(() =>
    expect(screen.getByLabelText("Gateway state")).toHaveTextContent(
      kind === "approval" ? '"approval":false' : '"prompt":false',
    ),
  );
  expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
  expect(screen.getByText("The conversation could not load. Try again.")).toBeVisible();
});

it.each(["approval", "mcp"] as const)(
  "only removes the matching %s on cancellation or external resolution before history",
  async (kind) => {
    const releasePage = holdHistory();
    await mountGateway();
    try {
      ask(kind);
      const title = await screen.findByText(
        kind === "approval" ? "Grant permissions" : "Allow the synthetic Computer Use tool?",
      );
      emitAgentEvent?.({
        type: "agent-input-resolved",
        kind: kind === "mcp" ? "prompt" : "approval",
        requestId: 999,
        agentId: "chief",
      });
      expect(title).toBeInTheDocument();
      emitAgentEvent?.({
        type: "agent-input-resolved",
        kind: kind === "mcp" ? "prompt" : "approval",
        requestId: kind === "approval" ? 14 : 15,
        agentId: "chief",
      });
      await waitFor(() => expect(title).not.toBeInTheDocument());
      expect(window.openbot.agent.respondToApproval).not.toHaveBeenCalled();
      expect(window.openbot.agent.respondToPrompt).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
    } finally {
      releasePage();
    }
  },
);

it("keeps a new agent prompt after the old agent answer settles", async () => {
  vi.mocked(window.openbot.agent.listAgents).mockResolvedValue(
    AGENTS.map((agent) => ({ ...agent, threadId: `thread-${agent.id}` })),
  );
  const releasePage = holdHistory();
  let releaseResponse!: () => void;
  const response = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  vi.mocked(window.openbot.agent.respondToPrompt).mockReturnValue(response);
  await mountGateway();
  try {
    ask("mcp");
    await reply("mcp");
    await waitFor(() => expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound, Outbound specialist/ }));
    await screen.findByRole("heading", { name: "Sales Outbound" });
    ask("mcp", "sales-outbound", 25);
    const newQuestion = await screen.findByText("Allow the synthetic Computer Use tool?");
    releaseResponse();
    await response;
    expect(newQuestion).toBeInTheDocument();
    expect(screen.getByText("Don't allow")).toBeInTheDocument();
    expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledExactlyOnceWith({
      requestId: 15,
      answers: { "mcp-elicitation-decision": ["Don't allow"] },
    });
  } finally {
    releasePage();
    releaseResponse();
  }
});

it("keeps a new server approval after the old server answer settles", async () => {
  const releasePage = holdHistory();
  const local = testServer("local", true),
    remote = testServer("remote-1", false);
  vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
  vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
    { ...local, active: serverId === "local" },
    { ...remote, active: serverId === "remote-1" },
  ]);
  let releaseResponse!: () => void;
  const response = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  vi.mocked(window.openbot.agent.respondToApproval).mockReturnValue(response);
  await mountGateway();
  try {
    ask("approval");
    await reply("approval");
    await waitFor(() => expect(window.openbot.agent.respondToApproval).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await screen.findByRole("heading", { name: "Chief" });
    ask("approval", "chief", 24);
    await screen.findByText("Synthetic gateway review 24");
    releaseResponse();
    await response;
    await waitFor(() => expect(screen.getByText("Synthetic gateway review 24")).toBeVisible());
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(window.openbot.agent.respondToApproval).toHaveBeenCalledExactlyOnceWith({
      requestId: 14,
      decision: "decline",
    });
  } finally {
    releasePage();
    releaseResponse();
  }
});

it("keeps a draft and its focus when pending history finishes without duplicating the prompt", async () => {
  const releasePage = holdHistory();
  await mountGateway();
  try {
    ask("mcp");
    const input = await screen.findByRole("textbox", {
      name: "Custom answer for: Allow the synthetic Computer Use tool?",
    });
    await fireEvent.input(input, { target: { value: "Keep this draft" } });
    input.focus();
    releasePage();
    await waitFor(() => expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":true'));
    expect(screen.getByRole("textbox", { name: "Custom answer for: Allow the synthetic Computer Use tool?" })).toBe(
      input,
    );
    expect(input).toHaveValue("Keep this draft");
    expect(input).toHaveFocus();
    expect(screen.getAllByText("Allow the synthetic Computer Use tool?")).toHaveLength(1);
    expect(window.openbot.agent.respondToPrompt).not.toHaveBeenCalled();
  } finally {
    releasePage();
  }
});

it("keeps history retry usable beside a pending manual request", async () => {
  vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValueOnce(
    new Error("Synthetic history unavailable"),
  );
  await mountGateway();
  await screen.findByText("The conversation could not load. Try again.");
  ask("approval");
  const card = await screen.findByText("Grant permissions");
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":true'));
  expect(screen.getByText("Grant permissions")).toBe(card);
  expect(window.openbot.agent.respondToApproval).not.toHaveBeenCalled();
});

it.each(["pending", "failed"] as const)(
  "renders browser attention with %s history and cancels only the original request",
  async (state) => {
    const releasePage = state === "pending" ? holdHistory() : () => undefined;
    if (state === "failed")
      vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValue(
        new Error("Synthetic history unavailable"),
      );
    await mountGateway();
    try {
      emitAgentEvent?.({
        type: "browser-changed",
        tabs: [browserTab("tab-gateway", "Gateway")],
        activeTabId: "tab-gateway",
      });
      emitAgentEvent?.({
        type: "browser-takeover-requested",
        request: {
          requestId: "browser-gateway",
          agentId: "chief",
          threadId: "thread-chief",
          turnId: "turn-1",
          tabId: "tab-gateway",
        },
      });
      await screen.findByRole("region", { name: "Browser takeover" });
      expect(screen.getByLabelText("Gateway state")).toHaveTextContent('"loaded":false');
      await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(window.openbot.agent.respondToBrowserTakeover).toHaveBeenCalledExactlyOnceWith({
          requestId: "browser-gateway",
          decision: "cancel",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("region", { name: "Browser takeover" })).not.toBeInTheDocument());
    } finally {
      releasePage();
    }
  },
);
