/* Zero-build dashboard: runs list, per-run tool-call trace, artifact viewer. */
"use strict";

function excerpt(text, limit) {
  var s = text === null || text === undefined ? "" : String(text);
  if (s.length > limit) return s.slice(0, limit) + "… [truncated]";
  return s;
}

function parsePayload(event) {
  try {
    return JSON.parse(event.payload_json);
  } catch (e) {
    return null;
  }
}

function budgetBurn(run) {
  if (run.budget === null || run.budget === undefined) return "—";
  try {
    return JSON.stringify(run.budget);
  } catch (e) {
    return String(run.budget);
  }
}

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function fetchJson(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error("request failed: " + url + " (" + res.status + ")");
  return res.json();
}

function renderRuns(runs) {
  var tbody = document.getElementById("runs-body");
  tbody.textContent = "";
  if (!Array.isArray(runs) || runs.length === 0) {
    var empty = document.createElement("tr");
    var cell = document.createElement("td");
    cell.setAttribute("colspan", "5");
    cell.textContent = "no runs";
    empty.appendChild(cell);
    tbody.appendChild(empty);
    return;
  }
  runs.forEach(function (run) {
    var row = document.createElement("tr");
    row.setAttribute("data-run-id", String(run.id));
    var idCell = el("td", null, String(run.id));
    var urlCell = el("td", null, String(run.issue_url));
    var statusCell = el("td", null, String(run.status));
    var verdictCell = el("td", null, run.verdict === null || run.verdict === undefined ? "—" : String(run.verdict));
    var budgetCell = el("td", null, budgetBurn(run));
    row.appendChild(idCell);
    row.appendChild(urlCell);
    row.appendChild(statusCell);
    row.appendChild(verdictCell);
    row.appendChild(budgetCell);
    row.addEventListener("click", function () {
      loadRun(run.id);
    });
    tbody.appendChild(row);
  });
}

function findNextGate(events, fromIndex, hypothesis) {
  for (var i = fromIndex + 1; i < events.length; i++) {
    if (events[i].kind !== "gate") continue;
    var payload = parsePayload(events[i]);
    if (payload === null) return { event: events[i], payload: null };
    if (hypothesis === undefined || payload.hypothesis === undefined || payload.hypothesis === hypothesis) {
      return { event: events[i], payload: payload };
    }
  }
  return null;
}

function renderTimeline(events) {
  var timeline = document.getElementById("timeline");
  timeline.textContent = "";
  var ordered = Array.isArray(events) ? events.slice().sort(function (a, b) { return a.seq - b.seq; }) : [];
  if (ordered.length === 0) {
    timeline.appendChild(el("p", null, "No events for this run."));
    return;
  }
  ordered.forEach(function (event, index) {
    var payload = parsePayload(event);
    var entry = el("div", "event");
    entry.setAttribute("data-kind", String(event.kind));
    entry.setAttribute("data-seq", String(event.seq));
    var header = el("p", "event-header");
    var kindSpan = el("span", "event-kind", String(event.kind));
    var seqSpan = el("span", "event-seq", " seq " + String(event.seq));
    header.appendChild(kindSpan);
    header.appendChild(seqSpan);
    entry.appendChild(header);

    if (event.kind === "tool_call" && payload !== null && payload.tool === "env_run") {
      var cmd = payload.cmd !== undefined ? payload.cmd : payload.command;
      if (cmd !== undefined) entry.appendChild(el("p", null, "command: " + String(cmd)));
      var stdout = payload.stdout !== undefined ? payload.stdout : "";
      var stderr = payload.stderr !== undefined ? payload.stderr : "";
      var output = excerpt("stdout:\n" + String(stdout) + "\nstderr:\n" + String(stderr), 2000);
      entry.appendChild(el("pre", null, output));
      var verdict = payload.verdict;
      var reason = payload.reason;
      if ((verdict === undefined || verdict === null) && payload.hypothesis !== undefined) {
        var next = findNextGate(ordered, index, payload.hypothesis);
        if (next !== null && next.payload !== null) {
          verdict = next.payload.verdict;
          reason = next.payload.reason;
        }
      }
      if (verdict !== undefined && verdict !== null) {
        entry.appendChild(el("p", null, "gate verdict: " + String(verdict) + (reason ? " — " + String(reason) : "")));
      }
    } else if (event.kind === "gate") {
      var verdictText = payload !== null && payload.verdict !== undefined ? String(payload.verdict) : "?";
      var reasonText = payload !== null && payload.reason ? " — " + String(payload.reason) : "";
      entry.appendChild(el("p", null, "gate verdict: " + verdictText + reasonText));
    } else if (event.kind === "sanitize_flag") {
      entry.classList.add("system-note");
      var flags = payload !== null && Array.isArray(payload.flags) ? payload.flags : [];
      entry.appendChild(el("p", null, "system note: sanitize flags: " + flags.map(String).join(", ")));
    } else {
      entry.appendChild(el("pre", null, excerpt(event.payload_json, 2000)));
    }
    timeline.appendChild(entry);
  });
}

function renderArtifacts(runId, summary) {
  var panel = document.getElementById("artifacts");
  panel.textContent = "";
  var names = [];
  if (summary !== null && summary !== undefined && Array.isArray(summary.artifacts)) {
    names = summary.artifacts.slice();
  }
  ["repro.py", "findings.md"].forEach(function (name) {
    if (names.indexOf(name) === -1) names.push(name);
  });
  if (names.length === 0) {
    panel.appendChild(el("p", null, "No artifacts."));
    return;
  }
  names.forEach(function (name) {
    var link = el("a", null, String(name));
    link.setAttribute("href", "/api/runs/" + encodeURIComponent(String(runId)) + "/artifacts/" + encodeURIComponent(String(name)));
    link.addEventListener("click", function (ev) {
      ev.preventDefault();
      viewArtifact(runId, name);
    });
    panel.appendChild(link);
    panel.appendChild(document.createTextNode(" "));
  });
}

async function viewArtifact(runId, name) {
  var view = document.getElementById("artifact-view");
  try {
    var res = await fetch("/api/runs/" + encodeURIComponent(String(runId)) + "/artifacts/" + encodeURIComponent(String(name)));
    if (!res.ok) {
      view.hidden = false;
      view.textContent = "artifact not found: " + name;
      return;
    }
    view.hidden = false;
    view.textContent = await res.text();
  } catch (e) {
    view.hidden = false;
    view.textContent = "failed to load artifact: " + name;
  }
}

async function loadRun(runId) {
  var meta = document.getElementById("run-meta");
  try {
    var run = await fetchJson("/api/runs/" + encodeURIComponent(String(runId)));
    meta.textContent = "";
    meta.appendChild(el("p", null, "run " + String(run.id) + " — " + String(run.issue_url) + " — status " + String(run.status) + " — verdict " + String(run.verdict)));
    var events = await fetchJson("/api/runs/" + encodeURIComponent(String(runId)) + "/events");
    renderTimeline(events);
    renderArtifacts(runId, run.summary);
  } catch (e) {
    meta.textContent = "";
    meta.appendChild(el("p", null, "Failed to load run " + String(runId) + "."));
  }
}

async function init() {
  try {
    var runs = await fetchJson("/api/runs");
    renderRuns(runs);
  } catch (e) {
    var tbody = document.getElementById("runs-body");
    tbody.textContent = "";
    var row = document.createElement("tr");
    var cell = document.createElement("td");
    cell.setAttribute("colspan", "5");
    cell.textContent = "failed to load runs";
    row.appendChild(cell);
    tbody.appendChild(row);
  }
}

document.addEventListener("DOMContentLoaded", init);
