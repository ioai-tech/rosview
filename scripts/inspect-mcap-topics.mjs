#!/usr/bin/env node
/**
 * Inspect MCAP topics (schema, encoding, message count, time range).
 * Works on indexed files via the summary section and falls back to a full
 * streaming scan for unindexed files (no summary, e.g. streamed recordings).
 * Usage: node scripts/inspect-mcap-topics.mjs path/to/file.mcap
 */
import fs from 'node:fs';
import path from 'node:path';

async function inspectIndexed(McapIndexedReader, fd, size) {
  const reader = await McapIndexedReader.Initialize({
    readable: {
      size: () => Promise.resolve(BigInt(size)),
      read: (offset, length) => {
        const buffer = new Uint8Array(Number(length));
        fs.readSync(fd, buffer, 0, buffer.byteLength, Number(offset));
        return Promise.resolve(buffer);
      },
    },
  });
  const counts = reader.statistics?.channelMessageCounts ?? new Map();
  return {
    indexed: true,
    profile: reader.header.profile,
    library: reader.header.library,
    channels: [...reader.channelsById.values()].map((channel) => ({
      channel,
      schema: reader.schemasById.get(channel.schemaId),
      count: Number(counts.get(channel.id) ?? 0),
    })),
  };
}

async function inspectStreaming(McapStreamReader, file) {
  const reader = new McapStreamReader({ validateCrcs: false });
  const schemas = new Map();
  const channels = new Map();
  const stats = new Map();
  let header;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 << 20 })) {
    reader.append(chunk);
    for (let record; (record = reader.nextRecord()); ) {
      if (record.type === 'Header') header = record;
      else if (record.type === 'Schema') schemas.set(record.id, record);
      else if (record.type === 'Channel') channels.set(record.id, record);
      else if (record.type === 'Message') {
        const entry = stats.get(record.channelId) ?? { count: 0, first: record.logTime, last: record.logTime };
        entry.count++;
        if (record.logTime < entry.first) entry.first = record.logTime;
        if (record.logTime > entry.last) entry.last = record.logTime;
        stats.set(record.channelId, entry);
      }
    }
  }
  return {
    indexed: false,
    profile: header?.profile,
    library: header?.library,
    channels: [...channels.values()].map((channel) => {
      const entry = stats.get(channel.id);
      return {
        channel,
        schema: schemas.get(channel.schemaId),
        count: entry?.count ?? 0,
        durationSec: entry ? Number(entry.last - entry.first) / 1e9 : undefined,
      };
    }),
  };
}

async function main() {
  const mcapPath = process.argv[2];
  if (!mcapPath) {
    console.error('Usage: node scripts/inspect-mcap-topics.mjs <file.mcap>');
    process.exit(1);
  }
  const resolved = path.resolve(mcapPath);
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved);
    process.exit(1);
  }

  const { McapIndexedReader, McapStreamReader } = await import('@mcap/core');
  const fd = fs.openSync(resolved, 'r');
  let result;
  try {
    result = await inspectIndexed(McapIndexedReader, fd, fs.fstatSync(fd).size);
  } catch (err) {
    console.error(`Indexed read failed (${err instanceof Error ? err.message : String(err)}); scanning the file instead.`);
    result = await inspectStreaming(McapStreamReader, resolved);
  } finally {
    fs.closeSync(fd);
  }

  const topics = result.channels
    .map(({ channel, schema, count, durationSec }) => ({
      topic: channel.topic,
      schema: schema?.name ?? 'unknown',
      schemaEncoding: schema?.encoding,
      messageEncoding: channel.messageEncoding,
      messageCount: count,
      ...(durationSec != null ? { durationSec } : {}),
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic));

  console.log(JSON.stringify({
    file: resolved,
    indexed: result.indexed,
    profile: result.profile,
    library: result.library,
    topicCount: topics.length,
    topics,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
