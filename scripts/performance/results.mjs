export const SCENARIOS = {
  "install.clean": {
    version: 1,
    endpoints: { totalMs: "installation-confirmed -> service-ready-and-final-validation" },
  },
  "app.restart": {
    version: 1,
    endpoints: {
      totalMs: "normal-exit-request -> observed-chat-ready",
      shutdownMs: "normal-exit-request -> desktop-and-owned-gateway-exited",
      launchToChatReadyMs: "electron-launch-call -> observed-chat-ready",
    },
  },
  "chat.new-session": {
    version: 1,
    endpoints: {
      totalMs: "new-conversation-click -> matching-final-body-after-paint-opportunity",
      sessionReadyMs: "new-conversation-click -> usable-empty-session",
      sendToFirstTextMs: "submit-keydown -> first-visible-answer-after-paint-opportunity",
      sendToFinalRenderedMs: "submit-keydown -> matching-final-body-after-paint-opportunity",
    },
  },
};

export function aggregate(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, median: null, min: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

export function emptyMetrics(scenarioId) {
  return Object.fromEntries(
    Object.keys(SCENARIOS[scenarioId].endpoints).map((metric) => [metric, null]),
  );
}

export function summarize(scenarios, samples) {
  const entries = scenarios.map((scenario) => {
    const attempts = samples.filter((sample) => sample.scenarioId === scenario.id);
    const successes = attempts.filter((sample) => sample.outcome === "success");
    const observed = attempts.filter(
      (sample) => !["unavailable", "skipped"].includes(sample.outcome),
    );
    const complete = successes.filter((sample) =>
      Object.keys(scenario.endpoints).every(
        (metric) => Number.isFinite(sample.metrics[metric]) && sample.metrics[metric] >= 0,
      ),
    );
    const metricNames = new Set(attempts.flatMap((sample) => Object.keys(sample.metrics)));
    return {
      id: scenario.id,
      coverage:
        complete.length === scenario.requestedSamples
          ? "measured"
          : observed.length
            ? "partial"
            : "unavailable",
      requested: scenario.requestedSamples,
      observed: observed.length,
      successful: successes.length,
      failed: observed.length - successes.length,
      unavailable: attempts.filter((sample) => sample.outcome === "unavailable").length,
      skipped: attempts.filter((sample) => sample.outcome === "skipped").length,
      metrics: Object.fromEntries(
        [...metricNames].map((metric) => [
          metric,
          aggregate(successes.map((sample) => sample.metrics[metric])),
        ]),
      ),
      failedElapsedMs: aggregate(
        observed.filter((sample) => sample.outcome !== "success").map((sample) => sample.elapsedMs),
      ),
    };
  });
  return {
    coverage: entries.every((entry) => entry.coverage === "measured")
      ? "measured"
      : entries.every((entry) => entry.coverage === "unavailable")
        ? "unavailable"
        : "partial",
    scenarios: entries,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function compare(candidate, baseline) {
  const issues = [];
  if (
    !baseline ||
    baseline.schemaVersion !== candidate.schemaVersion ||
    !Array.isArray(baseline.scenarios) ||
    !Array.isArray(baseline.summary?.scenarios) ||
    baseline.scenarios.some((entry) => !entry || typeof entry.id !== "string") ||
    baseline.summary.scenarios.some((entry) => !entry || typeof entry.id !== "string") ||
    !baseline.environment
  ) {
    return {
      status: "inconclusive",
      issues: ["Missing or incompatible baseline schema"],
      deltas: [],
    };
  }
  if (
    JSON.stringify(canonical(baseline.environment)) !==
    JSON.stringify(canonical(candidate.environment))
  ) {
    issues.push("Environment/runtime identity differs");
  }
  const deltas = [];
  for (const scenario of candidate.scenarios) {
    const previous = baseline.scenarios?.find((entry) => entry.id === scenario.id);
    const identity = (entry) =>
      entry && {
        version: entry.version,
        endpoints: entry.endpoints,
        profile: entry.profile,
        fixture: entry.fixture,
        cachePolicy: entry.cachePolicy,
        packaging: entry.packaging,
        requestedSamples: entry.requestedSamples,
      };
    if (
      JSON.stringify(canonical(identity(previous))) !==
      JSON.stringify(canonical(identity(scenario)))
    ) {
      issues.push(`${scenario.id}: scenario/profile/fixture/cache/packaging/sample count differs`);
      continue;
    }
    const currentSummary = candidate.summary.scenarios.find((entry) => entry.id === scenario.id);
    const previousSummary = baseline.summary?.scenarios?.find((entry) => entry.id === scenario.id);
    if (
      !Number.isFinite(currentSummary?.observed) ||
      currentSummary.observed <= 0 ||
      !Number.isFinite(previousSummary?.observed) ||
      previousSummary.observed <= 0
    ) {
      issues.push(`${scenario.id}: no comparable observed attempts`);
      continue;
    }
    const metrics = {};
    for (const [metric, current] of Object.entries(currentSummary.metrics)) {
      const old = previousSummary.metrics?.[metric];
      if (
        !current.count ||
        !old?.count ||
        !Number.isFinite(current.median) ||
        !Number.isFinite(old.median)
      )
        continue;
      metrics[metric] = {
        candidateCount: current.count,
        baselineCount: old.count,
        absoluteMs: current.median - old.median,
        relativePercent:
          old.median === 0 ? null : ((current.median - old.median) / old.median) * 100,
      };
    }
    if (!Object.keys(metrics).length)
      issues.push(`${scenario.id}: no corresponding successful metrics`);
    deltas.push({
      scenarioId: scenario.id,
      metrics,
      failureRateDelta:
        currentSummary.failed / currentSummary.observed -
        previousSummary.failed / previousSummary.observed,
    });
  }
  return {
    status: issues.length ? "inconclusive" : "comparable",
    runId: baseline.runId ?? null,
    source: baseline.source ?? null,
    issues,
    deltas,
    verdict: "not-evaluated: no agreed thresholds",
  };
}

const cell = (value) =>
  String(value ?? "unknown")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]/g, " ");
const timing = (value) => (value === null || value === undefined ? "n/a" : value.toFixed(2));

export function renderReport(result) {
  const lines = [
    "# MicroClaw performance report",
    "",
    `- Run: ${cell(result.runId)}`,
    `- Mode: ${result.mode}; coverage: ${result.summary.coverage}`,
    `- Source: ${cell(result.source.revision)}; dirty: ${cell(result.source.dirty)}`,
    `- Source fingerprint: ${cell(result.source.dirtySourceFingerprint)}`,
    `- Environment: ${cell(JSON.stringify(result.environment))}`,
    `- Executable SHA-256: ${cell(result.source.artifact?.executableSha256)}`,
    `- Application archive SHA-256: ${cell(result.source.artifact?.applicationSha256)}`,
    `- OpenClaw archive SHA-256: ${cell(result.source.artifact?.openclawRuntimeSha256)}`,
    `- Installer SHA-256: ${cell(result.source.installer?.sha256)}`,
    `- Artifact/source association: ${cell(result.source.artifact?.sourceAssociation)}`,
    `- Started: ${result.startedAt}; finished: ${result.finishedAt}`,
    "",
    "Timings are milliseconds. Parallel/nested stages must not be added together.",
    "Small sample sets do not establish tail latency. Failed durations are not successful timings.",
    "",
  ];
  for (const scenario of result.scenarios) {
    const summary = result.summary.scenarios.find((entry) => entry.id === scenario.id);
    lines.push(
      `## ${scenario.id}`,
      "",
      `Profile: ${scenario.profile}; packaging: ${scenario.packaging}; cache: ${scenario.cachePolicy}.`,
      `Coverage: ${summary.coverage}; successful ${summary.successful}/${summary.requested}; failed ${summary.failed}; unavailable ${summary.unavailable}; skipped ${summary.skipped}.`,
      `Fixture: ${cell(JSON.stringify(scenario.fixture))}`,
      "",
      "| Metric | Successful samples | Median | Min | Max |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const [metric, stats] of Object.entries(summary.metrics)) {
      lines.push(
        `| ${metric} | ${stats.count} | ${timing(stats.median)} | ${timing(stats.min)} | ${timing(stats.max)} |`,
      );
    }
    lines.push("", "### Attempts", "");
    for (const sample of result.samples.filter((entry) => entry.scenarioId === scenario.id)) {
      lines.push(
        `- ${sample.sampleId}: ${sample.outcome}; attempt elapsed ${timing(sample.elapsedMs)} ms; ${cell(sample.failure?.message ?? "completed")}`,
        `  - Metrics: ${cell(JSON.stringify(sample.metrics))}`,
        `  - Evidence: ${sample.evidence.map(cell).join(", ") || "none"}`,
      );
    }
    const stages = Object.entries(summary.metrics)
      .filter(([name, stats]) => name.startsWith("stage.") && stats.count)
      .sort((left, right) => right[1].median - left[1].median);
    if (stages.length)
      lines.push(
        "",
        `Slowest observed stages: ${stages
          .slice(0, 5)
          .map(([name, stats]) => `${name} ${timing(stats.median)} ms`)
          .join("; ")}.`,
      );
    lines.push("", `Metric endpoints: ${cell(JSON.stringify(scenario.endpoints))}`, "");
  }
  lines.push("## Limitations", "", ...result.limitations.map((entry) => `- ${cell(entry)}`), "");
  if (result.mode === "compare") {
    lines.push(
      "## Comparison",
      "",
      `Status: ${result.baseline.status}. ${result.baseline.verdict ?? ""}`,
      ...result.baseline.issues.map((entry) => `- ${cell(entry)}`),
      "",
      "```json",
      JSON.stringify(result.baseline.deltas, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}
