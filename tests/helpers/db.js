// Modified 2026-11-23: require an explicit disposable local test database.
let MongooseHistoryPlugin = require('../../index');

let getRandomName = () => (0 | (Math.random() * 9e6)).toString(36);

module.exports = (mongoose) => {
  const connectionString = process.env.MONGO_HISTORY_TEST_URI;
  if (process.env.MONGO_HISTORY_TEST_DB !== 'true' || !connectionString) {
    throw new Error('Set MONGO_HISTORY_TEST_DB=true and MONGO_HISTORY_TEST_URI for disposable Mongo tests.');
  }
  let target;
  try {
    target = new URL(connectionString);
  } catch (error) {
    throw new Error('MONGO_HISTORY_TEST_URI must identify a disposable local Mongo instance.');
  }
  const hosts = ['localhost', '127.0.0.1', '[::1]', 'mongo', 'mongodb'];
  if (target.protocol !== 'mongodb:' || !hosts.includes(target.hostname) || target.username || target.password) {
    throw new Error('Mongo tests only accept an unauthenticated local harness endpoint.');
  }
  const dbname = `mongo_perf_history_${process.pid}_${getRandomName()}`;
  const connectionOptions = { dbName: dbname, useNewUrlParser: true, useUnifiedTopology: true };

  return {
    dbname,
    MongooseHistoryPlugin,
    connectionString,
    connectionOptions,
    getRandomName,
    async start({ log }) {
      await mongoose.connect(connectionString, connectionOptions, function (error) {
        if (error) {
          throw error;
        }
        log(`Mongoose connected to disposable test database "${dbname}"`);
      });
    },
    async close() {
      await mongoose.connection.db.dropDatabase();
      await mongoose.connection.close();
    },
    async dropCollection(name) {
      try {
        await mongoose.connection.db.dropCollection(name);
      } catch (error) {
        if (error.message !== 'ns not found') {
          throw error;
        }
      }
    },
    async dropCollections() {
      let collections = Object.keys(mongoose.connection.collections);

      for (let name of collections) {
        try {
          await mongoose.connection.collections[name].drop();
        } catch (error) {
          if (error.message !== 'ns not found') {
            throw error;
          }
        }
      }
    }
  };
};
