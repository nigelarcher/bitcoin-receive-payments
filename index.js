var EventEmitter = require('events').EventEmitter
var BLT = require('../bitcoin-live-transactions')
var bitcore = require('bitcore-lib')
var HDPublicKey = bitcore.HDPublicKey
var Address = bitcore.Address
var Networks = bitcore.Networks
var secondsInCache15 = 60 * 15
var secondsInCache14 = 60 * 14
var secondsInCache10 = 60 * 10
var secondsInCache5 = 60 * 5
var redis = require('redis')
var client = redis.createClient()
var maxGap = 15
var debugbrp = require('debug')('brp')
var debugaddress = require('debug')('brp:address')
var randomstring = require('randomstring')

// var env = process.env.NODE_ENV || 'development';
// var config = require('./config')[env];
// require('./config/mongoose')(config);
// client.flushdb()

module.exports = Gateway

var setAddressInUse = async (address, id, rawid) => {
  await Promise.all([
    new Promise(resolve => client.set('address-' + address, id, (_, reply) => client.expireat('address-' + address, parseInt((+new Date()) / 1000) + secondsInCache15, () => resolve()))),
    new Promise(resolve => client.set('rawid-address-' + address, rawid, (_, reply) => client.expireat('address-' + address, parseInt((+new Date()) / 1000) + secondsInCache15, () => resolve()))),
    new Promise(resolve => client.set('address-expiration-' + address, parseInt((+new Date()) / 1000) + secondsInCache15, (_, reply) => client.expireat('address-' + address, parseInt((+new Date()) / 1000) + secondsInCache15, () => resolve()))),
    new Promise(resolve => client.set('id-' + id, address, (_, reply) => client.expireat('id-' + id, parseInt((+new Date()) / 1000) + secondsInCache10, () => resolve())))
  ])
}
var secondsLeftForAddress = address => {
  return new Promise((resolve, reject) => client.get('address-expiration-' + address, (_, reply) => {
    if (reply !== undefined) {
      resolve(reply)
    } else {
      reject()
    }
  })
  )
}

var idHasAddressAssigned = (id) => {
  return new Promise(resolve => client.get('id-' + id, (_, reply) => {
    resolve(reply)
  }))
}

var idAssignedToAddress = (address) => {
  return new Promise((resolve, reject) => client.get('rawid-address-' + address, (_, reply) => {
    if (reply === null) {
      reject()
    } else {
      resolve(reply)
    }
  })
  )
}

var isAddressAvailable = (address, id, rawid) => {
  return new Promise((resolve, reject) => client.get('address-' + address, (_, reply) => {
    if (!reply) {
      setAddressInUse(address, id, rawid).then(() => {
        resolve(address)
      })
    } else {
      reject(address)
    }
  })
  )
}

var generateKey = () => randomstring.generate({
  length: 14,
  charset: 'abcdefghijklmnpqrstuvwxyz1234567890'
})

function Gateway (xpub, exchangeKey) {
  var self = this
  self.ies = {}
  if (!(self instanceof Gateway)) return new Gateway(xpub, exchangeKey)
  self.xpub = xpub
  self.unused_addresses = []
  self.addresses_count = 0
  self.events = new EventEmitter()

  self.retrieved = new HDPublicKey(self.xpub)
  var bitcoin = BLT()

  self.uBTCtoSAT = (amount) => {
    return amount * 100
  }

  self.SATtouBTC = (amount) => {
    return amount / 100
  }

  self.receivedPayment = async (payment, xpubinfo, initializedCallback) => {
    // self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    try {
      const id = await idAssignedToAddress(payment.address)
      payment.id = id
      self.events.emit('payment', payment)
      self.events.emit(payment.address, payment)
      self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    } catch (e) {
      self.events.emit('payment', payment)
      self.events.emit(payment.address, payment)
      self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    }
  }

  self.forgetAddress = async (address, xpubinfo, initializedCallback) => {
    // debugaddress('ADDRESS USED:', address.toString())
    await Promise.all([
      new Promise(resolve => client.lrem('available-addresses' + xpubinfo._id, 0, address.toString(), () => resolve())),
      new Promise(resolve => client.sadd('used-addresses' + xpubinfo._id, address.toString(), () => resolve())),
      new Promise(resolve => client.get('address-' + address, (_, reply) => {
        if (reply != null) {
          client.del('id-' + reply)
        }
        resolve()
      }))
    ])
    await self.checkAddress(xpubinfo, self.ies[xpubinfo._id], initializedCallback)
    self.ies[xpubinfo._id] = self.ies[xpubinfo._id] + 1
  }
  var initialized = {}
  var addressCount = {}
  self.checkAddress = async (xpubinfo, i, initializedCallback) => {
    // console.log('xpubinfo', xpubinfo)
    var retrieved = new HDPublicKey(xpubinfo.xpub)
    var derived = retrieved.derive(0).derive(i)
    var address = new Address(derived.publicKey, Networks.livenet)

    client.lrem('available-addresses' + xpubinfo._id, 0, address.toString())
    client.rpush('available-addresses' + xpubinfo._id, address.toString())
    // debugaddress('<checkAddress>', i, address)

    await new Promise(resolve => client.sismember('used-addresses' + xpubinfo._id, address.toString(), async (_, res) => {
      if (res !== 0) {
        await self.forgetAddress(address.toString(), xpubinfo, initializedCallback)
      } else {
        try {
          const transaction = await bitcoin.getBalance(address.toString())
          if (transaction.txs > 0) {
            await new Promise(resolve => client.get('address-' + address.toString(), async (_, reply) => {
              if (reply != null) {
                await self.receivedPayment({ address: address.toString(), amount: self.uBTCtoSAT(transaction.in) }, xpubinfo, initializedCallback)
              } else {
                await self.forgetAddress(address.toString(), xpubinfo, initializedCallback)
              }
              resolve()
            }))
          } else {
            throw new Error('No Transactions')
          }
        } catch (e) {
          debugbrp('Monitoring address:', address.toString())
          if (addressCount[xpubinfo._id] === undefined) {
            addressCount[xpubinfo._id] = 0
          }
          addressCount[xpubinfo._id] = addressCount[xpubinfo._id] + 1
          console.log('address_count', addressCount)
          bitcoin.events.on(address.toString(), function (payment) {
            self.receivedPayment(payment, xpubinfo, initializedCallback)
          })
          if (addressCount[xpubinfo._id] > 4 && initialized[xpubinfo._id] !== true) {
            initialized[xpubinfo._id] = true
            initializedCallback()
            // self.events.emit('initialized')
          }
        }
      }
      resolve()
    }))
  }

  self.lastrandom = 0
  self.newrandom = 0

  self.check_gap = async (xpubinfo, callback) => {
    debugaddress('<check_gap>', xpubinfo)
    if (self.ies[xpubinfo._id] === undefined) {
      self.ies[xpubinfo._id] = 0
    }
    let a = self.ies[xpubinfo._id]
    if (a < maxGap) {
      for (a = 0; a < maxGap; a++) {
        await self.checkAddress(xpubinfo, a, callback)
      }
      // xpubinfo.i = a;
      self.ies[xpubinfo._id] = a
    } else {
      callback()
    }
  }

  self.creatingAddress = false

  self.getOneAvailable = async (id, rawid, addresses, a) => {
    debugaddress('<getOneAvailable>', id)
    try {
      return await isAddressAvailable(addresses[a], id, rawid)
    } catch (e) {
      debugaddress('a:', a, 'max_gap', maxGap)
      if (a < (maxGap - 1)) {
        debugaddress('getOneAvailable')
        return await self.getOneAvailable(id, rawid, addresses, a + 1)
      } else {
        debugaddress('reject')
        throw e
      }
    }
  }

  var creatingAddresses = {}
  self.createAddress = (id) => {
    console.log('<createAddress>', self.xpub, id)
    return new Promise((resolve, reject) => {
      client.get(self.xpub, (_, xpubid) => {
        if (xpubid == null) {
          xpubid = generateKey()
          client.set(self.xpub, xpubid, (_, reply) => {
            console.log('set new key', xpubid, 'for xpub:', self.xpub)
          })
        }
        console.log('got key', xpubid)

        var success = async (address) => {
          creatingAddresses[xpubinfo._id] = false
          const secondsLeft = await secondsLeftForAddress(address)
          resolve({ address: address, seconds_left: (parseInt(secondsLeft) - parseInt(+new Date()) / 1000) })
        }

        var processCreateRequest = async () => {
          const assignedAddress = await idHasAddressAssigned(id + xpubinfo._id)
          if (assignedAddress) {
            success(assignedAddress)
          } else {
            client.lrange('available-addresses' + xpubinfo._id, 0, -1, async (_, addresses) => {
              if (creatingAddresses[xpubinfo._id] !== true) {
                creatingAddresses[xpubinfo._id] = true
                try {
                  const address = await self.getOneAvailable(id + xpubinfo._id, id, addresses, 0)
                  success(address)
                } catch (e) {
                  reject(e)
                }
              } else {
                self.newrandom = 100 + 500 * Math.random()
                while (self.lastrandom === self.newrandom) {
                  self.newrandom = 100 + 1000 * Math.random()
                }
                setTimeout(async () => {
                  try {
                    const address = await self.getOneAvailable(id + xpubinfo._id, id, addresses, 0)
                    success(address)
                  } catch (e) {
                    reject(e)
                  }
                }, self.newrandom)
                self.lastrandom = self.newrandom
              }
            })
          }
        }

        var xpubinfo = { _id: xpubid, xpub: self.xpub }
        if (self.ies[xpubinfo._id] === undefined) {
          self.check_gap(xpubinfo, processCreateRequest)
        } else {
          processCreateRequest()
        }
      })
    })
  }

  self.connect = () => {
    bitcoin.events.on('connected', () => {
      // self.check_gap()
    })
    bitcoin.connect()
  }

  return self
}
