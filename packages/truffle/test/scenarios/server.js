var Ganache = require("ganache");
var fs = require("fs-extra");
var glob = require("glob");

var server = null;

module.exports = {
  start: function(done) {
    this.stop(function() {
      if (!process.env.GETH) {
        server = Ganache.server({ vmErrorsOnRPCResponse: true, legacyInstamine: true, gasLimit: 6721975 });
        server.listen(8545, done);
      } else {
        done();
      }
    });
  },
  stop: function(done) {
    var self = this;
    if (server) {
      server.close(function() {
        server = null;
        self.cleanUp().then(done);
      });
    } else {
      self.cleanUp().then(done);
    }
  },

  cleanUp: function() {
    return new Promise((resolve, reject) => {
      glob("tmp-*", (err, files) => {
        if (err) reject(err);

        files.forEach(file => fs.removeSync(file));
        resolve();
      });
    });
  }
};
