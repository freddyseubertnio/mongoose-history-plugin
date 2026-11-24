// Added 2026-11-23: additive indexes and unchanged legacy history reconstruction.
const test = require('ava');
const mongoose = require('mongoose');
const DbHelper = require('./helpers/db');

const db = DbHelper(mongoose);
test.before('Connect to disposable Mongo', db.start);
test.after.always('Drop disposable Mongo database', db.close);

const lookupKey = (field = 'timestamp') => ({ collectionName: 1, collectionId: 1, [field]: 1 });

// The flag acknowledges destructive cleanup; the database name is always generated.
test('requires explicit local test opt-in and never uses the URI database name', (t) => {
  const previousUri = process.env.MONGO_HISTORY_TEST_URI;
  const previousFlag = process.env.MONGO_HISTORY_TEST_DB;
  try {
    delete process.env.MONGO_HISTORY_TEST_DB;
    t.throws(() => DbHelper(mongoose), { message: /disposable Mongo tests/ });
    process.env.MONGO_HISTORY_TEST_DB = 'true';
    for (const uri of ['mongodb://example.invalid:27017', 'mongodb+srv://mongo', 'mongodb://user:password@localhost:27017']) {
      process.env.MONGO_HISTORY_TEST_URI = uri;
      t.throws(() => DbHelper(mongoose), { message: /local harness endpoint/ });
    }
    process.env.MONGO_HISTORY_TEST_URI = 'mongodb://localhost:27017/do_not_drop';
    const guarded = DbHelper(mongoose);
    t.regex(guarded.dbname, /^mongo_perf_history_/);
    t.is(guarded.connectionOptions.dbName, guarded.dbname);
    t.not(guarded.dbname, 'do_not_drop');
  } finally {
    if (previousUri === undefined) delete process.env.MONGO_HISTORY_TEST_URI;
    else process.env.MONGO_HISTORY_TEST_URI = previousUri;
    if (previousFlag === undefined) delete process.env.MONGO_HISTORY_TEST_DB;
    else process.env.MONGO_HISTORY_TEST_DB = previousFlag;
  }
});

test('declares a nonunique lookup index and preserves existing unrelated indexes', async (t) => {
  db.MongooseHistoryPlugin({ mongoose, modelName: '__index_histories' });
  const History = mongoose.model('__index_histories');
  const declared = History.schema.indexes().find(([key]) => JSON.stringify(key) === JSON.stringify(lookupKey()));
  t.truthy(declared);
  t.is(declared[1].name, 'history_lookup');
  t.not(declared[1].unique, true);
  await History.init();
  await History.collection.createIndex({ event: 1 }, { name: 'operator_event' });
  await History.ensureIndexes();
  await History.ensureIndexes();
  const indexes = await History.collection.indexes();
  t.deepEqual(indexes.find((index) => index.name === 'history_lookup').key, lookupKey());
  t.not(indexes.find((index) => index.name === 'history_lookup').unique, true);
  t.truthy(indexes.find((index) => index.name === 'operator_event'));
});

test('uses the configured timestamp on an alternate connection and isolates shared collections', async (t) => {
  const connection = await mongoose.createConnection(db.connectionString, {
    ...db.connectionOptions, dbName: db.dbname + '_alternate', autoIndex: false
  });
  try {
    const plugin = db.MongooseHistoryPlugin({ mongoose, connection, modelName: '__shared_history', timestampFieldName: 'recorded_at' });
    const makeModel = (name) => {
      const schema = new mongoose.Schema({ value: String });
      schema.plugin(plugin);
      return connection.model(name, schema);
    };
    const First = makeModel('IndexFirst');
    const Second = makeModel('IndexSecond');
    const History = connection.model('__shared_history');
    t.false(Object.hasOwn(mongoose.models, '__shared_history'));
    await History.ensureIndexes();
    const indexes = await History.collection.indexes();
    t.deepEqual(indexes.find((index) => index.name === 'history_lookup').key, lookupKey('recorded_at'));
    const sharedId = new mongoose.Types.ObjectId();
    const first = new First({ _id: sharedId, value: 'first' });
    const second = new Second({ _id: sharedId, value: 'second' });
    await first.save();
    await second.save();
    const firstDiffs = await first.getDiffs();
    const secondDiffs = await second.getDiffs();
    t.is(firstDiffs.length, 1);
    t.is(secondDiffs.length, 1);
    t.is(firstDiffs[0].collectionName, 'IndexFirst');
    t.is(secondDiffs[0].collectionName, 'IndexSecond');
    t.true(firstDiffs[0].recorded_at instanceof Date);
    t.false(Object.hasOwn(firstDiffs[0], 'timestamp'));
    t.is((await first.getVersion('0.0.0')).object.value, 'first');
    t.is((await second.getVersion('0.0.0')).object.value, 'second');
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
});

test('adding the index preserves legacy array and nested map replay and comparison', async (t) => {
  const connection = await mongoose.createConnection(db.connectionString, {
    ...db.connectionOptions, dbName: db.dbname + '_legacy', autoIndex: false
  });
  try {
    const schema = new mongoose.Schema({ tags: [String], settings: { type: Map, of: String } });
    schema.plugin(db.MongooseHistoryPlugin({ mongoose, connection, modelName: '__legacy_history' }));
    const Item = connection.model('LegacyItem', schema);
    const History = connection.model('__legacy_history');
    const id = new mongoose.Types.ObjectId();
    await History.collection.insertMany([
      { collectionName: 'LegacyItem', collectionId: id, version: '0.0.0', timestamp: new Date('2020-01-01T00:00:00Z'), diff: { _id: [String(id)], tags: { _t: 'a', 0: ['first'] }, settings: [{ finish: 'base', density: 'one' }] } },
      { collectionName: 'LegacyItem', collectionId: id, version: '1.0.0', timestamp: new Date('2020-01-01T00:00:01Z'), diff: { tags: { _t: 'a', 1: ['second'] }, settings: { finish: ['base', 'next'] } } },
      { collectionName: 'LegacyItem', collectionId: id, version: '2.0.0', timestamp: new Date('2020-01-01T00:00:02Z'), diff: { settings: { density: ['one', 'two'] } } }
    ]);
    const item = new Item({ _id: id });
    const originalRows = await History.collection.find({}).toArray();
    const before = await item.getVersions();
    t.deepEqual(before[2].object, { _id: String(id), tags: ['first', 'second'], settings: { finish: 'next', density: 'two' } });
    await History.collection.createIndex(lookupKey(), { name: 'existing_lookup' });
    await History.ensureIndexes();
    const indexes = await History.collection.indexes();
    t.truthy(indexes.find((index) => index.name === 'existing_lookup'));
    t.is(indexes.filter((index) => JSON.stringify(index.key) === JSON.stringify(lookupKey())).length, 1);
    t.deepEqual(await item.getVersions(), before);
    t.deepEqual((await item.getVersions({ sort: '-timestamp' })).map((version) => version.version), ['2.0.0', '1.0.0', '0.0.0']);
    t.deepEqual((await item.getVersion('1.0.0')).object, before[1].object);
    const comparison = await item.compareVersions('1.0.0', '2.0.0');
    t.deepEqual(comparison.diff, { settings: { density: ['one', 'two'] } });
    t.deepEqual(comparison.left, before[1].object);
    t.deepEqual(comparison.right, before[2].object);
    t.deepEqual(await History.collection.find({}).toArray(), originalRows);
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
});
