// Added 2026-11-23: semantic version selection with tied and out-of-order clocks.
const test = require('ava');
const mongoose = require('mongoose');
const DbHelper = require('./helpers/db');
const pluginFactory = require('../index');

const db = DbHelper(mongoose);
const snapshot = (id, version) => ({
  _id: String(id), value: version, settings: { mode: `stage${version}` }, tags: [`tag${version}`],
});

for (const timestamp of ['timestamp', 'recorded_at']) {
  for (const variant of ['ties', 'reverse_ties', 'clock_disagreement']) {
    test(`semantic history selection with ${variant} and ${timestamp}`, async t => {
      const connection = await mongoose.createConnection(db.connectionString, {
        ...db.connectionOptions, dbName: `${db.dbname}_${timestamp}_${variant}`, autoIndex: false,
      });
      try {
        const schema = new mongoose.Schema({
          value: Number, settings: { type: Map, of: String }, tags: [String],
        }, { versionKey: false });
        schema.plugin(pluginFactory({ mongoose, connection, modelName: 'ordering_versions', timestampFieldName: timestamp }));
        const Fixture = connection.model('OrderFixture', schema);
        const History = connection.model('ordering_versions');
        const id = new mongoose.Types.ObjectId();
        const rows = Array.from({ length: 11 }, (_, revision) => {
          const clock = variant !== 'clock_disagreement' && revision === 10 ? 9
            : variant === 'clock_disagreement' && revision === 9 ? 11 : revision;
          return { collectionName: 'OrderFixture', collectionId: id,
            version: `${revision}.0.0`, [timestamp]: new Date(Date.UTC(2020, 0, 1) + clock * 1000),
            diff: revision === 0 ? {
              _id: [String(id)], value: [0], settings: [{ mode: 'stage0' }], tags: [['tag0']],
            } : {
              value: [revision - 1, revision], settings: { mode: [`stage${revision - 1}`, `stage${revision}`] },
              tags: { _t: 'a', 0: [`tag${revision - 1}`, `tag${revision}`] },
            },
          };
        });
        const insertionOrder = variant === 'reverse_ties' ? [...rows.slice(0, 9), rows[10], rows[9]] : rows;
        await History.collection.insertMany(insertionOrder);
        await History.ensureIndexes();
        await Fixture.collection.insertOne({ _id: id, value: 10, settings: { mode: 'stage10' }, tags: ['tag10'] });
        const document = await Fixture.findById(id);
        const selected = await document.getVersion('10.0.0');
        t.is(selected.version, '10.0.0');
        t.deepEqual(selected.object, snapshot(id, 10));
        const above = await document.getVersion('999.0.0');
        t.is(above.version, '10.0.0');
        t.deepEqual(above.object, snapshot(id, 10));
        t.is((await document.getVersion('0.0.0-0')).version, '0.0.0');
        const raw = await document.getVersion('10.0.0', false);
        t.truthy(raw.diff);
        t.false(Object.hasOwn(raw, 'object'));
        t.is((await document.getDiff('10.0.0')).version, '10.0.0');
        t.is(await document.getDiff('999.0.0'), null);
        const comparison = await document.compareVersions('9.0.0', '10.0.0');
        t.deepEqual(comparison.left, snapshot(id, 9));
        t.deepEqual(comparison.right, snapshot(id, 10));
        t.deepEqual(comparison.diff.value, [9, 10]);
        for (const direction of [1, -1]) {
          const versions = await document.getVersions({ sort: { [timestamp]: direction } });
          t.true(versions.every((row, index) => index === 0 ||
            (row[timestamp].getTime() - versions[index - 1][timestamp].getTime()) * direction >= 0));
          for (const row of versions) t.deepEqual(row.object, snapshot(id, Number(row.version.split('.')[0])));
        }
        const lexicographic = await document.getVersions({ sort: { version: 1 } });
        t.deepEqual(lexicographic.map(row => row.version), rows.map(row => row.version).sort());
        for (const row of lexicographic) t.deepEqual(row.object, snapshot(id, Number(row.version.split('.')[0])));
        await document.save();
        t.is(await History.countDocuments({ collectionId: id }), 11);
        for (const value of [11, 12]) {
          document.value = value;
          document.settings.set('mode', `stage${value}`);
          document.tags[0] = `tag${value}`;
          document.markModified('tags');
          await document.save();
          const appended = await document.getDiff(`${value}.0.0`);
          t.truthy(appended);
          t.deepEqual(appended.diff.value, [value - 1, value]);
          t.deepEqual((await document.getVersion(`${value}.0.0`)).object, snapshot(id, value));
        }
        const finalRows = await History.collection.find({ collectionId: id }).toArray();
        t.is(finalRows.length, 13);
        t.is(new Set(finalRows.map(row => row.version)).size, 13);
        t.is((await Fixture.findById(id)).value, 12);
      } finally { await connection.dropDatabase(); await connection.close(); }
    });
  }
}

test('overlapping saves observe a version committed after the snapshot read', async t => {
  const connection = await mongoose.createConnection(db.connectionString, {
    ...db.connectionOptions, dbName: db.dbname + '_overlap', autoIndex: false,
  });
  let resume;
  let pending;
  try {
    const schema = new mongoose.Schema({ value: Number }, { versionKey: false });
    schema.plugin(pluginFactory({ mongoose, connection, modelName: 'overlap_versions' }));
    const Fixture = connection.model('OverlapFixture', schema);
    const History = connection.model('overlap_versions');
    await History.ensureIndexes();
    const initial = await Fixture.create({ value: 0 });
    await History.collection.updateOne({ collectionId: initial._id, version: '0.0.0' }, {
      $set: { timestamp: new Date('2020-01-01T00:00:00Z') },
    });
    const first = await Fixture.findById(initial._id);
    const second = await Fixture.findById(initial._id);
    let read;
    const snapshotRead = new Promise(resolve => { read = resolve; });
    const resumed = new Promise(resolve => { resume = resolve; });
    const original = second.getVersions.bind(second);
    second.getVersions = async (...args) => {
      const versions = await original(...args);
      read();
      await resumed;
      return versions;
    };
    second.value = 2;
    pending = second.save();
    await snapshotRead;
    first.value = 1;
    await first.save();
    resume();
    await pending;
    const rows = await History.collection.find({ collectionId: initial._id }).toArray();
    t.deepEqual(rows.map(row => row.version).sort(), ['0.0.0', '1.0.0', '2.0.0']);
    t.is((await Fixture.findById(initial._id)).value, 2);
    // This protects fresh version observation, not atomic concurrent snapshot updates.
  } finally {
    if (resume) resume();
    if (pending) await pending.catch(() => {});
    await connection.dropDatabase();
    await connection.close();
  }
});
