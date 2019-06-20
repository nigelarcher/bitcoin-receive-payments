const fs = require('fs')
const moment = require('moment-timezone')
var EventEmitter = require('events').EventEmitter
var BLT = require('../bitcoin-live-transactions')
const Bitcoin = require('bitcoinjs-lib')
var secondsInCache15 = 60 * 15
var secondsInCache14 = 60 * 14
var secondsInCache10 = 60 * 10
var secondsInCache5 = 60 * 5
// var redis = require('redis')
// var client = redis.createClient()
var maxGap = 15
var debugbrp = require('debug')('brp')
var debugaddress = require('debug')('brp:address')
var randomstring = require('randomstring')

module.exports = Gateway

let storeData = null
const store = {
  init: () => {
    try {
      storeData = JSON.parse(fs.readFileSync('../payments.json'))
    } catch (e) {
      storeData = {
        expiry: {}
      }
    }
  },
  get: field => {
    const data = storeData[field]
    const dataExpiry = storeData.expiry[field]
    if(!dataExpiry || moment.utc(dataExpiry) > moment.utc()) {
      return data || null
    } else {
      delete storeData[field]
      delete storeData.expiry[field]
      return null
    }
  },
  set: (field, data, expiry) => {
    storeData[field] = data
    if (expiry) {
      storeData.expiry[field] = moment.utc(expiry).toISOString()
    }
    fs.writeFileSync('../payments.json', JSON.stringify(storeData, null, 2))
  },
  remove: (field, data) => {
    if (!data) {
      delete storeData[field]
      delete storeData.expiry[field]
    } else {
      let array = storeData[field] || []
      array = array.filter(i => i !== data)
      storeData[field] = array
      fs.writeFileSync('../payments.json', JSON.stringify(storeData, null, 2))  
    }
  },
  add: (field, value) => {
    const array = storeData[field] || []
    array.push(value)
    storeData[field] = array
    fs.writeFileSync('../payments.json', JSON.stringify(storeData, null, 2))
  },
  exists: (field, value) => {
    const array = storeData[field] || []
    return array.includes(value)
  },
}

var setAddressInUse = (address, id, rawid) => {
  store.set(`address-${address}`, id, moment.utc().add(secondsInCache15, 'seconds'))
  store.set(`rawid-address-${address}`, rawid, moment.utc().add(secondsInCache15, 'seconds'))
  store.set(`rawidaddress-expiration-${address}`, moment.utc().add(secondsInCache15, 'seconds').toISOString(), moment.utc().add(secondsInCache15, 'seconds'))
  store.set(`id-${id}`, address, moment.utc().add(secondsInCache10, 'seconds'))
}

var secondsLeftForAddress = address => {
  const addressExpiry = store.get(`rawidaddress-expiration-${address}`)
  if (addressExpiry) {
    const endDate = moment(addressExpiry)
    return endDate.diff(moment(), 'seconds')
  }
  return null
}

var idHasAddressAssigned = (id) => {
  return store.get(`id-${id}`)
}

var idAssignedToAddress = (address) => {
  return store.get(`rawid-address-${address}`)
}

var isAddressAvailable = (address, id, rawid) => {
  const reply = store.get(`address-${address}`)
  if (!reply) {
    setAddressInUse(address, id, rawid)
    return true
  }
  return false
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

  try {
    self.baseWallet = Bitcoin.bip32.fromBase58(xpub).neutered()
  } catch(e) {
    console.log(e)
  }
  var bitcoin = BLT({ testnet: false })

  self.uBTCtoSAT = (amount) => {
    return amount * 100
  }

  self.SATtouBTC = (amount) => {
    return amount / 100
  }

  self.receivedPayment = async (payment, xpubinfo, initializedCallback) => {
    // self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    const id = idAssignedToAddress(payment.address)
    if (id) {
      payment.id = id
      self.events.emit('payment', payment)
      self.events.emit(payment.address, payment)
      self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    } else {
      self.events.emit('payment', payment)
      self.events.emit(payment.address, payment)
      self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    }
  }

  self.forgetAddress = async (address, xpubinfo, initializedCallback) => {
    // debugaddress('ADDRESS USED:', address.toString())
    store.remove(`available-addresses-${xpubinfo._id}`, address.toString())
    store.add(`used-addresses-${xpubinfo._id}`, address.toString())
    const id = store.get(`address-${address}`)
    if (id != null) {
      store.remove(`id-${id}`)
    }
    await self.checkAddress(xpubinfo, self.ies[xpubinfo._id], initializedCallback)
    self.ies[xpubinfo._id] = self.ies[xpubinfo._id] + 1
  }

  var initialized = {}
  var addressCount = {}
  self.checkAddress = async (xpubinfo, i, initializedCallback) => {
    // console.log('xpubinfo', xpubinfo)
    var baseWallet = self.baseWallet
    var derived = baseWallet.derive(0).derive(i)
    
    const { address } = Bitcoin.payments.p2sh({
      redeem: Bitcoin.payments.p2wpkh({ pubkey: derived.publicKey })
    })
    
    console.log(address)    
    store.remove(`available-addresses-${xpubinfo._id}`, address.toString())
    store.add(`available-addresses-${xpubinfo._id}`, address.toString())
    // debugaddress('<checkAddress>', i, address)

    const isUsed = store.exists(`used-addresses-${xpubinfo._id}`, address.toString())
    if (isUsed) {
        self.forgetAddress(address.toString(), xpubinfo, initializedCallback)
    } else {
      const transaction = await bitcoin.getBalance(address.toString())
      if (transaction.txs > 0) {
        const address = store.get('address-' + address.toString())
        if (address != null) {
          self.receivedPayment({ address: address.toString(), amount: self.uBTCtoSAT(transaction.in) }, xpubinfo, initializedCallback)
        } else {
          self.forgetAddress(address.toString(), xpubinfo, initializedCallback)
        }
      } else {
        debugbrp('Monitoring address:', address.toString())
        if (addressCount[xpubinfo._id] === undefined) {
          addressCount[xpubinfo._id] = 0
        }
        addressCount[xpubinfo._id] = addressCount[xpubinfo._id] + 1
        console.log('address_count', addressCount)
        bitcoin.events.on(address.toString(), (payment) => {
          self.receivedPayment(payment, xpubinfo, initializedCallback)
        })
        if (addressCount[xpubinfo._id] > 4 && initialized[xpubinfo._id] !== true) {
          initialized[xpubinfo._id] = true
          initializedCallback()
          // self.events.emit('initialized')
        }
      }
    }
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

  self.getOneAvailable = (id, rawid, addresses) => {
    debugaddress('<getOneAvailable>', id)
    const address = addresses.find(a => isAddressAvailable(a, id, rawid))
    if(!address) {
      throw new Error('No avaliable addresses')
    } else {
      return address
    }
  }

  var creatingAddresses = {}
  self.createAddress = (id) => {
    console.log('<createAddress>', self.xpub, id)
    return new Promise((resolve, reject) => {
      let xpubid = store.get(self.xpub)
      if (xpubid === null) {
        xpubid = generateKey()
        store.set(self.xpub, xpubid)
      }
      console.log('got key', xpubid)

      var success = async (address) => {
        creatingAddresses[xpubinfo._id] = false
        const secondsLeft = secondsLeftForAddress(address)
        resolve({ address: address, seconds_left: secondsLeft })
      }

      var processCreateRequest = async () => {
        const assignedAddress = idHasAddressAssigned(id + xpubinfo._id)
        if (assignedAddress) {
          success(assignedAddress)
        } else {
          const addresses = store.get(`available-addresses-${xpubinfo._id}`)
          if (creatingAddresses[xpubinfo._id] !== true) {
            creatingAddresses[xpubinfo._id] = true
            try {
              const address = self.getOneAvailable(id + xpubinfo._id, id, addresses, 0)
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
        }
      }

      var xpubinfo = { _id: xpubid, xpub: self.xpub }
      if (self.ies[xpubinfo._id] === undefined) {
        self.check_gap(xpubinfo, processCreateRequest)
      } else {
        processCreateRequest()
      }
    })
  }

  self.connect = () => {
    bitcoin.events.on('connected', () => {
      // self.check_gap()
      store.init()
      self.events.emit('initialized')
    })
    bitcoin.connect()
  }

  return self
}
