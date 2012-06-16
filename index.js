var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , Node = require('./lib/node')
  , default_port = 6379
  , default_host = '127.0.0.1'
  , default_retry_timeout = 1000
  , default_reorientate_wait = 10000
  , commands = require('./node_modules/redis/lib/commands')
  , async = require('async')
  , uuid = require('./lib/uuid')
  ;

function createClient(nodes, options) {
  return new RedisHAClient(nodes, options);
}
exports.createClient = createClient;

function RedisHAClient(nodeList, options) {
  EventEmitter.call(this);
  options = options || {};
  this.retryTimeout = options.retryTimeout || default_retry_timeout;
  this.orientating = false;
  this.nodes = [];
  this.queue = [];
  this.ready = false;
  this.on('ready', function() {
    this.ready = true;
    this.orientating = false;
    console.log('ready, using ' + this.master + ' as master');
    this.drainQueue();
  });
  this.parseNodeList(nodeList, options);
}
util.inherits(RedisHAClient, EventEmitter);

commands.forEach(function(k) {
  commands.push(k.toUpperCase());
});

commands.forEach(function(k) {
  RedisHAClient.prototype[k] = function() {
    var args = Array.prototype.slice.call(arguments);
    if (!this.ready) {
      // @todo: create a custom multi() method which can return a chainable thing
      // instead here.
      this.queue.push([k, args]);
      return;
    }
    var preferSlave = false, node;
    k = k.toLowerCase();
    switch(k) {
      case 'bitcount':
      case 'get':
      case 'getbit':
      case 'getrange':
      case 'hget':
      case 'hgetall':
      case 'hkeys':
      case 'hlen':
      case 'hmget':
      case 'hvals':
      case 'keys':
      case 'lindex':
      case 'llen':
      case 'lrange':
      case 'mget':
      case 'psubscribe':
      case 'pttl':
      case 'punsubscribe':
      case 'scard':
      case 'sinter':
      case 'sismember':
      case 'smembers':
      case 'srandmember':
      case 'strlen':
      case 'subscribe':
      case 'sunion':
      case 'ttl':
      case 'type':
      case 'unsubscribe':
      case 'zcard':
      case 'zrange':
      case 'zrangebyscore':
      case 'zrank':
      case 'zrevrange':
      case 'zrevrangebyscore':
      case 'zrevrank':
      case 'zscore':
        preferSlave = true;
        break;
      case 'sort':
        // @todo: parse to see if "store" is used
        break;
    }
    if (preferSlave) {
      node = this.randomSlave();
    }
    else {
      // For write operations, increment an op counter, to judge freshness of slaves.
      var self = this;
      this.master.client.INCR('haredis:opcounter', function(err, reply) {
        if (err) {
          // Emitting an error on master will cause failover!
          self.master.emit('error', err);
        }
      });
    }
    if (!node) {
      node = this.master;
    }
    if (k == 'subscribe') {
      console.log('subscribing to ' + args[0] + ' on ' + node);
    }
    return node.client[k].apply(node.client, args);
  };
});

RedisHAClient.prototype.drainQueue = function() {
  if (this.ready && this.queue.length) {
    // Call the next command in the queue
    var item = this.queue.shift();
    this[item[0]].apply(this, item[1]);

    // Wait till nextTick to do next command
    var self = this;
    process.nextTick(function() {
      self.drainQueue();
    });
  }
};

RedisHAClient.prototype.parseNodeList = function(nodeList, options) {
  var self = this;
  nodeList.forEach(function(n) {
    if (typeof n == 'object') {
      options = n;
    }
    else {
      if (typeof n == 'number') {
        n = n + "";
      }
      var parts = n.split(':');
      var spec = {};
      if (/^\d+$/.test(parts[0])) {
        spec.port = parseInt(parts[0]);
        spec.host = default_host;
      }
      else if (parts.length == 2) {
        spec.host = parts[0];
        spec.port = parseInt(parts[1]);
      }
      else {
        spec.host = parts[0];
        spec.port = default_port;
      }
    }
    var node = new Node(spec, options);
    node.on('up', function() {
      console.log(this + ' is up');
      if (self.responded.length == nodeList.length) {
        self.orientate();
      }
    });
    node.on('down', function() {
      console.log(this + ' is down');
      if (self.responded.length == nodeList.length) {
        self.orientate();
      }
      else {
        console.log('only ' + self.responded.length + ' responded with ' + nodeList.length + ' in nodeList');
      }
    });
    node.on('error', function(err) {
      console.warn(err);
    });
    node.on('gossip:master', function(key) {
      if (!self.ready && !self.orientating) {
        var node = self.nodeFromKey(key);
        if (!node) {
          return console.log('gossip said ' + key + " was promoted, but can't find record of it...");
        }
        if (node.status == 'up') {
          console.log('gossip said ' + node + ' was promoted, switching to it. woohoo!');
          self.master = node;
          self.master.role = 'master';
          self.emit('ready');
        }
        else {
          // Hasten reconnect
          if (node.client.retry_timer) {
            clearInterval(node.client.retry_timer);
          }
          console.log('gossip said ' + node + ' was promoted, hastening reconnect');
          node.client.stream.connect(node.port, node.host);
        }
      }
    });
    self.nodes.push(node);
  });
};

RedisHAClient.prototype.orientate = function() {
  if (this.orientating) {
    return;
  }
  console.log('orientating...');
  this.orientating = true;
  if (this.retryInterval) {
    clearInterval(this.retryInterval);
  }
  var tasks = [], self = this;
  this.ready = false;
  if ((this.up.length / this.down.length) <= 0.5) {
    console.log("refusing to orientate without a majority up! (" + this.up.length + '/' + this.nodes.length + ')');
    return this.reorientate();
  }
  this.up.forEach(function(node) {
    tasks.push(function(cb) {
      node.client.INFO(function(err, reply) {
        if (err) {
          node.client.emit('error', err);
          // Purposely don't pass err to cb so parallel() can continue
          return cb(null, node);
        }
        var info = node.info = Node.parseInfo(reply);
        node.role = info.role;
        if (info.loading && info.loading !== '0') {
          err = new Error(node + ' still loading');
          return cb(err);
        }
        else if (info.master_host) {
          // Resolve the host to prevent false duplication
          Node.resolveHost(info.master_host, function(err, host) {
            if (err) {
              node.client.emit('error', err);
              // Purposely don't pass err so parallel() can continue
              return cb(null, node);
            }
            node.info.master_host = host;
            cb(null, node);
          });
        }
        else {
          // Node is a master
          cb(null, node);
        }
      });
    });
  });
  async.parallel(tasks, function(err, nodes) {
    if (err) {
      console.warn(err);
      return self.reorientate();
    }
    var masters = []
      , slaves = []
      , master_host
      , master_port
      , master_conflict = false
      ;
    nodes.forEach(function(node) {
      if (node.info.role == 'master') {
        masters.push(node);
      }
      else if (node.info.role == 'slave') {
        if (master_host && master_host != node.info.master_host) {
          master_conflict = true;
        }
        master_host = node.info.master_host;
        master_port = node.info.master_port;
        slaves.push(node);
      }
    });
    if (masters.length != 1) {
      // Resolve multiple/no masters
      console.warn('invalid master count: ' + masters.length);
      self.failover();
    }
    else if (slaves.length && (master_conflict || master_host != masters[0].host || master_port != masters[0].port)) {
      console.warn('master conflict detected');
      self.failover();
    }
    else {
      self.master = masters.pop();
      self.emit('ready');
    }
  });
};

RedisHAClient.prototype.makeSlave = function(node, cb) {
  if (!this.master) {
    return console.error("can't make " + node + " a slave of unknown master!");
  }
  if (node.host == this.master.host && node.port == this.master.port) {
    return console.warn('refusing to make ' + node + ' a slave of itself!');
  }
  console.log('making ' + node + ' into a slave...');
  node.client.SLAVEOF(this.master.host, this.master.port, function(err, reply) {
    if (err) {
      return cb(err);
    }
    node.role = 'slave';
    console.log(node + ' is slave');
    cb();
  });
};

RedisHAClient.prototype.failover = function() {
  if (this.ready) {
    return console.log('ignoring failover while ready');
  }
  console.log('attempting failover!');
  var tasks = [];
  var id = uuid();
  console.log('my failover id: ' + id);
  var self = this;
  // We can't use a regular EXPIRE call because of a bug in redis which prevents
  // slaves from expiring keys correctly.
  var lock_time = 5000;
  this.up.forEach(function(node) {
    tasks.push(function(cb) {
      node.client.MULTI()
        .SETNX('haredis:failover', id + ':' + Date.now())
        .GET('haredis:failover', function(err, reply) {
          reply = reply.split(':');
          if (reply[0] != id && (Date.now() - reply[1] < lock_time)) {
            return cb(new Error('failover already in progress: ' + reply[0]));
          }
        })
        .EXEC(function(err, replies) {
          if (err) {
            console.error(err, 'error locking node');
            // Don't pass the error, so parallel() can continue.
            cb(null, node);
          }
          else {
            // set a shortish ttl on the lock
            node.client.EXPIRE('haredis:failover', 5, function(err) {
              if (err) {
                console.error(err, 'error setting ttl on lock');
              }
            });
            node.client.GET('haredis:opcounter', function(err, opcounter) {
              if (err) {
                console.error(err, 'error getting opcounter');
                // Don't pass the error, so parallel() can continue.
                cb(null, node);
              }
              else {
                node.opcounter = opcounter;
                cb(null, node);
              }
            });
          }
        });
    });
  });
  async.parallel(tasks, function(err, results) {
    if (results.length) {
      console.log('unlocking nodes after ' + (err ? 'unsuccessful' : 'successful') + ' lock...');
      results.forEach(function(node) {
        if (node) {
          node.client.DEL('haredis:failover', function(err) {
            if (err) {
              return console.error(err, 'error unlocking ' + node);
            }
            console.log('unlocked ' + node);
          });
        }
      });
    }
    if (err) {
      console.warn(err);
      return self.reorientate();
    }
    else {
      // We've succeeded in locking all the nodes. Now elect our new master...
      var winner;
      results.forEach(function(node) {
        if (!winner || node.opcounter > winner.opcounter) {
          winner = node;
        }
      });
      if (winner) {
        console.log(winner + ' had highest opcounter (' + winner.opcounter + ') of ' + self.up.length + ' nodes. congrats!');
      }
      else {
        console.error('election had no winner!?');
        return self.reorientate();
      }

      winner.client.SLAVEOF('NO', 'ONE', function(err) {
        if (err) {
          console.error(err, 'error electing master');
          return self.reorientate();
        }
        self.master = winner;
        self.master.role = 'master';
        self.orientating = false;
        self.emit('ready');

        var tasks = [];
        self.up.forEach(function(node) {
          if (!self.isMaster(node)) {
            tasks.push(function(cb) {
              self.makeSlave(node, cb);
            });
          }
        });
        if (tasks.length) {
          async.parallel(tasks, function(err) {
            if (err) {
              return console.error(err, 'error making slave!');
            }
            console.log('publishing gossip:master for ' + self.master.toString());
            self.master.client.publish('haredis:gossip:master', self.master.toString());
          });
        }
      });
    }
  });
};

RedisHAClient.prototype.isMaster = function(node) {
  return this.master && this.master.toString() == node.toString();
};

RedisHAClient.prototype.reorientate = function() {
  var self = this;
  this.orientating = false;
  console.log('reorientating in ' + default_reorientate_wait + 'ms');
  this.retryInterval = setTimeout(function() {
    self.orientate();
  }, default_reorientate_wait);
};

RedisHAClient.prototype.__defineGetter__('slaves', function() {
  return this.nodes.filter(function(node) {
    return node.role == 'slave' && node.status == 'up';
  });
});

RedisHAClient.prototype.__defineGetter__('responded', function() {
  return this.nodes.filter(function(node) {
    return node.status != 'initializing';
  });
});

RedisHAClient.prototype.__defineGetter__('up', function() {
  return this.nodes.filter(function(node) {
    return node.status == 'up';
  });
});

RedisHAClient.prototype.__defineGetter__('down', function() {
  return this.nodes.filter(function(node) {
    return node.status == 'down';
  });
});

RedisHAClient.prototype.isUp = function(key) {
  return this.nodes.some(function(node) {
    return node.toString() == key && node.status == 'up';
  });
};

RedisHAClient.prototype.nodeFromKey = function(key) {
  return this.nodes.filter(function(node) {
    return node.toString() == key;
  })[0];
};

RedisHAClient.prototype.randomSlave = function() {
  return this.slaves[Math.round(Math.random() * this.slaves.length - 1)];
};