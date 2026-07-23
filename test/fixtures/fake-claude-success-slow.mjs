#!/usr/bin/env node
// Same shape as fake-claude-success.mjs, with a short deliberate delay before
// emitting — gives once.test.mjs a window to observe the job still 'running'
// (and the process still alive) partway through, proving once-mode drains
// in-flight work instead of exiting out from under it.
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(2000);

const structuredOutput = {
  newsroom_url: null,
  tldr: 'Runner Test Co is a fixture company used only by the runner lifecycle tests.',
  facts: [
    {
      section: 'news',
      text: 'Runner Test Co was created as a fixture for the runner lifecycle tests.',
      fact_date: '2026-07-15',
      importance: 5,
      stats: null,
      group_key: null,
      sources: [
        {
          publisher: 'Test Wire',
          title: 'Runner Test Co fixture announcement',
          url: `https://runner-test.example/news/fixture-slow-${process.pid}-${Date.now()}`,
          year: 2026,
        },
      ],
    },
  ],
};

console.log(JSON.stringify([{ structured_output: structuredOutput }]));
