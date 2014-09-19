/**
 * Password-based encryption functions.
 *
 * @author Dave Longley
 * @author Stefan Siegl <stesie@brokenpipe.de>
 *
 * Copyright (c) 2010-2013 Digital Bazaar, Inc.
 * Copyright (c) 2012 Stefan Siegl <stesie@brokenpipe.de>
 *
 * An EncryptedPrivateKeyInfo:
 *
 * EncryptedPrivateKeyInfo ::= SEQUENCE {
 *   encryptionAlgorithm  EncryptionAlgorithmIdentifier,
 *   encryptedData        EncryptedData }
 *
 * EncryptionAlgorithmIdentifier ::= AlgorithmIdentifier
 *
 * EncryptedData ::= OCTET STRING
 */
(function() {
/* ########## Begin module implementation ########## */
function initModule(forge) {

if(typeof BigInteger === 'undefined') {
  var BigInteger = forge.jsbn.BigInteger;
}

var ByteBuffer = forge.util.ByteBuffer;

// shortcut for asn.1 API
var asn1 = forge.asn1;

/* Password-based encryption implementation. */
var pki = forge.pki = forge.pki || {};
pki.pbe = forge.pbe = forge.pbe || {};
var oids = pki.oids;

// validator for an EncryptedPrivateKeyInfo structure
// Note: Currently only works w/algorithm params
var encryptedPrivateKeyValidator = {
  name: 'EncryptedPrivateKeyInfo',
  tagClass: asn1.Class.UNIVERSAL,
  type: asn1.Type.SEQUENCE,
  constructed: true,
  value: [{
    name: 'EncryptedPrivateKeyInfo.encryptionAlgorithm',
    tagClass: asn1.Class.UNIVERSAL,
    type: asn1.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: 'AlgorithmIdentifier.algorithm',
      tagClass: asn1.Class.UNIVERSAL,
      type: asn1.Type.OID,
      constructed: false,
      capture: 'encryptionOid'
    }, {
      name: 'AlgorithmIdentifier.parameters',
      tagClass: asn1.Class.UNIVERSAL,
      type: asn1.Type.SEQUENCE,
      constructed: true,
      capture: {
        name: 'encryptionParams',
        format: 'asn1'
      }
    }]
  }, {
    // encryptedData
    name: 'EncryptedPrivateKeyInfo.encryptedData',
    tagClass: asn1.Class.UNIVERSAL,
    type: asn1.Type.OCTETSTRING,
    constructed: false,
    capture: 'encryptedData'
  }]
};

// validator for a PBES2Algorithms structure
// Note: Currently only works w/PBKDF2 + AES encryption schemes
var PBES2AlgorithmsValidator = {
  name: 'PBES2Algorithms',
  tagClass: asn1.Class.UNIVERSAL,
  type: asn1.Type.SEQUENCE,
  constructed: true,
  value: [{
    name: 'PBES2Algorithms.keyDerivationFunc',
    tagClass: asn1.Class.UNIVERSAL,
    type: asn1.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: 'PBES2Algorithms.keyDerivationFunc.oid',
      tagClass: asn1.Class.UNIVERSAL,
      type: asn1.Type.OID,
      constructed: false,
      capture: 'kdfOid'
    }, {
      name: 'PBES2Algorithms.params',
      tagClass: asn1.Class.UNIVERSAL,
      type: asn1.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: 'PBES2Algorithms.params.salt',
        tagClass: asn1.Class.UNIVERSAL,
        type: asn1.Type.OCTETSTRING,
        constructed: false,
        capture: 'kdfSalt'
      }, {
        name: 'PBES2Algorithms.params.iterationCount',
        tagClass: asn1.Class.UNIVERSAL,
        type: asn1.Type.INTEGER,
        onstructed: true,
        capture: {
          name: 'kdfIterationCount',
          format: 'number'
        }
      }]
    }]
  }, {
    name: 'PBES2Algorithms.encryptionScheme',
    tagClass: asn1.Class.UNIVERSAL,
    type: asn1.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: 'PBES2Algorithms.encryptionScheme.oid',
      tagClass: asn1.Class.UNIVERSAL,
      type: asn1.Type.OID,
      constructed: false,
      capture: 'encOid'
    }, {
      name: 'PBES2Algorithms.encryptionScheme.iv',
      tagClass: asn1.Class.UNIVERSAL,
      type: asn1.Type.OCTETSTRING,
      constructed: false,
      capture: 'encIv'
    }]
  }]
};

var pkcs12PbeParamsValidator = {
  name: 'pkcs-12PbeParams',
  tagClass: asn1.Class.UNIVERSAL,
  type: asn1.Type.SEQUENCE,
  constructed: true,
  value: [{
    name: 'pkcs-12PbeParams.salt',
    tagClass: asn1.Class.UNIVERSAL,
    type: asn1.Type.OCTETSTRING,
    constructed: false,
    capture: 'salt'
  }, {
    name: 'pkcs-12PbeParams.iterations',
    tagClass: asn1.Class.UNIVERSAL,
    type: asn1.Type.INTEGER,
    constructed: false,
    capture: {
      name: 'iterations',
      format: 'number'
    }
  }]
};

/**
 * Encrypts a ASN.1 PrivateKeyInfo object, producing an EncryptedPrivateKeyInfo.
 *
 * PBES2Algorithms ALGORITHM-IDENTIFIER ::=
 *   { {PBES2-params IDENTIFIED BY id-PBES2}, ...}
 *
 * id-PBES2 OBJECT IDENTIFIER ::= {pkcs-5 13}
 *
 * PBES2-params ::= SEQUENCE {
 *   keyDerivationFunc AlgorithmIdentifier {{PBES2-KDFs}},
 *   encryptionScheme AlgorithmIdentifier {{PBES2-Encs}}
 * }
 *
 * PBES2-KDFs ALGORITHM-IDENTIFIER ::=
 *   { {PBKDF2-params IDENTIFIED BY id-PBKDF2}, ... }
 *
 * PBES2-Encs ALGORITHM-IDENTIFIER ::= { ... }
 *
 * PBKDF2-params ::= SEQUENCE {
 *   salt CHOICE {
 *     specified OCTET STRING,
 *     otherSource AlgorithmIdentifier {{PBKDF2-SaltSources}}
 *   },
 *   iterationCount INTEGER (1..MAX),
 *   keyLength INTEGER (1..MAX) OPTIONAL,
 *   prf AlgorithmIdentifier {{PBKDF2-PRFs}} DEFAULT algid-hmacWithSHA1
 * }
 *
 * @param obj the ASN.1 PrivateKeyInfo object.
 * @param password the password to encrypt with.
 * @param options:
 *          algorithm the encryption algorithm to use
 *            ('aes128', 'aes192', 'aes256', '3des'), defaults to 'aes128'.
 *          count the iteration count to use.
 *          saltSize the salt size to use.
 *
 * @return the ASN.1 EncryptedPrivateKeyInfo.
 */
pki.encryptPrivateKeyInfo = function(obj, password, options) {
  // set default options
  options = options || {};
  options.saltSize = options.saltSize || 8;
  options.count = options.count || 2048;
  options.algorithm = options.algorithm || 'aes128';

  // generate PBE params
  var salt = new ByteBuffer(forge.random.getBytesSync(options.saltSize));
  var count = options.count;
  var dkLen;
  var encryptionAlgorithm;
  var encryptedData;
  if(options.algorithm.indexOf('aes') === 0 || options.algorithm === 'des') {
    // Do PBES2
    var ivLen, encOid, algorithm;
    switch(options.algorithm) {
    case 'aes128':
      dkLen = 16;
      ivLen = 16;
      encOid = oids['aes128-CBC'];
      algorithm = 'AES-CBC';
      break;
    case 'aes192':
      dkLen = 24;
      ivLen = 16;
      encOid = oids['aes192-CBC'];
      algorithm = 'AES-CBC';
      break;
    case 'aes256':
      dkLen = 32;
      ivLen = 16;
      encOid = oids['aes256-CBC'];
      algorithm = 'AES-CBC';
      break;
    case 'des':
      dkLen = 8;
      ivLen = 8;
      encOid = oids['desCBC'];
      algorithm = 'DES-CBC';
      break;
    default:
      var error = new Error(
        'Cannot encrypt private key. Unknown encryption algorithm.');
      error.algorithm = options.algorithm;
      throw error;
    }

    // encrypt private key using pbe SHA-1 and AES/DES
    var dk = forge.pkcs5.pbkdf2(password, salt, count, dkLen);
    var iv = new ByteBuffer(forge.random.getBytesSync(ivLen));
    var cipher = forge.cipher.createCipher(algorithm, dk);
    cipher.start({iv: iv});
    cipher.update(asn1.toDer(obj));
    cipher.finish();
    encryptedData = cipher.output;

    encryptionAlgorithm = asn1.create(
      asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, oids.pkcs5PBES2),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        // keyDerivationFunc
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
            oids.pkcs5PBKDF2),
          // PBKDF2-params
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            // salt
            asn1.create(
              asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, salt),
            // iteration count
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, count)
          ])
        ]),
        // encryptionScheme
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, encOid),
          // iv
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, iv)
        ])
      ])
    ]);
  } else if(options.algorithm === '3des') {
    // Do PKCS12 PBE
    dkLen = 24;

    var dk = pki.pbe.generatePkcs12Key(password, salt, 1, count, dkLen);
    var iv = pki.pbe.generatePkcs12Key(password, salt, 2, count, dkLen);
    var cipher = forge.cipher.createCipher(algorithm, dk);
    cipher.start({iv: iv});
    cipher.update(asn1.toDer(obj));
    cipher.finish();
    encryptedData = cipher.output;

    encryptionAlgorithm = asn1.create(
      asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
        oids['pbeWithSHAAnd3-KeyTripleDES-CBC']),
      // pkcs-12PbeParams
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        // salt
        asn1.create(
          asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, salt),
        // iteration count
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, count)
      ])
    ]);
  } else {
    var error = new Error(
      'Cannot encrypt private key. Unknown encryption algorithm.');
    error.algorithm = options.algorithm;
    throw error;
  }

  // EncryptedPrivateKeyInfo
  var rval = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    // encryptionAlgorithm
    encryptionAlgorithm,
    // encryptedData
    asn1.create(
      asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, encryptedData)
  ]);
  return rval;
};

/**
 * Decrypts a ASN.1 PrivateKeyInfo object.
 *
 * @param obj the ASN.1 EncryptedPrivateKeyInfo object.
 * @param password the password to decrypt with.
 *
 * @return the ASN.1 PrivateKeyInfo on success, null on failure.
 */
pki.decryptPrivateKeyInfo = function(obj, password) {
  var rval = null;

  // get PBE params
  var capture = {};
  var errors = [];
  if(!asn1.validate(obj, encryptedPrivateKeyValidator, capture, errors)) {
    var error = new Error('Cannot read encrypted private key. ' +
      'ASN.1 object is not a supported EncryptedPrivateKeyInfo.');
    error.errors = errors;
    throw error;
  }

  // get cipher
  var cipher = pki.pbe.getDecipher(
    capture.encryptionOid, capture.encryptionParams, password);

  // get encrypted data
  cipher.update(capture.encryptedData);
  if(cipher.finish()) {
    rval = asn1.fromDer(cipher.output);
  }

  return rval;
};

/**
 * Converts a EncryptedPrivateKeyInfo to PEM format.
 *
 * @param epki the EncryptedPrivateKeyInfo.
 * @param maxline the maximum characters per line, defaults to 64.
 *
 * @return the PEM-formatted encrypted private key.
 */
pki.encryptedPrivateKeyToPem = function(epki, maxline) {
  // convert to DER, then PEM-encode
  var msg = {
    type: 'ENCRYPTED PRIVATE KEY',
    body: asn1.toDer(epki)
  };
  return forge.pem.encode(msg, {maxline: maxline});
};

/**
 * Converts a PEM-encoded EncryptedPrivateKeyInfo to ASN.1 format. Decryption
 * is not performed.
 *
 * @param pem the EncryptedPrivateKeyInfo in PEM-format.
 *
 * @return the ASN.1 EncryptedPrivateKeyInfo.
 */
pki.encryptedPrivateKeyFromPem = function(pem) {
  var msg = forge.pem.decode(pem)[0];

  if(msg.type !== 'ENCRYPTED PRIVATE KEY') {
    var error = new Error('Could not convert encrypted private key from PEM; ' +
      'PEM header type is "ENCRYPTED PRIVATE KEY".');
    error.headerType = msg.type;
    throw error;
  }
  if(msg.procType && msg.procType.type === 'ENCRYPTED') {
    throw new Error('Could not convert encrypted private key from PEM; ' +
      'PEM is encrypted.');
  }

  // convert DER to ASN.1 object
  return asn1.fromDer(msg.body);
};

/**
 * Encrypts an RSA private key. By default, the key will be wrapped in
 * a PrivateKeyInfo and encrypted to produce a PKCS#8 EncryptedPrivateKeyInfo.
 * This is the standard, preferred way to encrypt a private key.
 *
 * To produce a non-standard PEM-encrypted private key that uses encapsulated
 * headers to indicate the encryption algorithm (old-style non-PKCS#8 OpenSSL
 * private key encryption), set the 'legacy' option to true. Note: Using this
 * option will cause the iteration count to be forced to 1.
 *
 * Note: The 'des' algorithm is supported, but it is not considered to be
 * secure because it only uses a single 56-bit key. If possible, it is highly
 * recommended that a different algorithm be used.
 *
 * @param rsaKey the RSA key to encrypt.
 * @param password the password to use.
 * @param options:
 *          algorithm: the encryption algorithm to use
 *            ('aes128', 'aes192', 'aes256', '3des', 'des').
 *          count: the iteration count to use.
 *          saltSize: the salt size to use.
 *          legacy: output an old non-PKCS#8 PEM-encrypted+encapsulated
 *            headers (DEK-Info) private key.
 *
 * @return the PEM-encoded ASN.1 EncryptedPrivateKeyInfo.
 */
pki.encryptRsaPrivateKey = function(rsaKey, password, options) {
  // standard PKCS#8
  options = options || {};
  if(!options.legacy) {
    // encrypt PrivateKeyInfo
    var rval = pki.wrapRsaPrivateKey(pki.privateKeyToAsn1(rsaKey));
    rval = pki.encryptPrivateKeyInfo(rval, password, options);
    return pki.encryptedPrivateKeyToPem(rval);
  }

  // legacy non-PKCS#8
  var algorithm;
  var iv;
  var dkLen;
  switch(options.algorithm) {
  case 'aes128':
    algorithm = 'AES-128-CBC';
    dkLen = 16;
    iv = forge.random.getBytesSync(16);
    break;
  case 'aes192':
    algorithm = 'AES-192-CBC';
    dkLen = 24;
    iv = forge.random.getBytesSync(16);
    break;
  case 'aes256':
    algorithm = 'AES-256-CBC';
    dkLen = 32;
    iv = forge.random.getBytesSync(16);
    break;
  case '3des':
    algorithm = '3DES-CBC';
    dkLen = 24;
    iv = forge.random.getBytesSync(8);
    break;
  case 'des':
    algorithm = 'DES-CBC';
    dkLen = 8;
    iv = forge.random.getBytesSync(8);
    break;
  default:
    var error = new Error('Could not encrypt RSA private key; unsupported ' +
      'encryption algorithm "' + options.algorithm + '".');
    error.algorithm = options.algorithm;
    throw error;
  }

  // encrypt private key using OpenSSL legacy key derivation
  var dk = evpBytesToKey(password, iv.substr(0, 8), dkLen);
  var cipher = forge.cipher.createCipher(algorithm, dk);
  cipher.start({iv: new ByteBuffer(iv)});
  cipher.update(asn1.toDer(pki.privateKeyToAsn1(rsaKey)));
  cipher.finish();

  var msg = {
    type: 'RSA PRIVATE KEY',
    procType: {
      version: '4',
      type: 'ENCRYPTED'
    },
    dekInfo: {
      algorithm: algorithm,
      parameters: forge.util.bytesToHex(iv).toUpperCase()
    },
    body: cipher.output
  };
  return forge.pem.encode(msg);
};

/**
 * Decrypts an RSA private key.
 *
 * @param pem the PEM-formatted EncryptedPrivateKeyInfo to decrypt.
 * @param password the password to use.
 *
 * @return the RSA key on success, null on failure.
 */
pki.decryptRsaPrivateKey = function(pem, password) {
  var rval = null;

  var msg = forge.pem.decode(pem)[0];

  if(msg.type !== 'ENCRYPTED PRIVATE KEY' &&
    msg.type !== 'PRIVATE KEY' &&
    msg.type !== 'RSA PRIVATE KEY') {
    var error = new Error(
      'Could not convert private key from PEM; PEM header type ' +
      'is not "ENCRYPTED PRIVATE KEY", "PRIVATE KEY", or "RSA PRIVATE KEY".');
    error.headerType = error;
    throw error;
  }

  if(msg.procType && msg.procType.type === 'ENCRYPTED') {
    var dkLen;
    var decipherFn;
    switch(msg.dekInfo.algorithm) {
    case 'DES-CBC':
      dkLen = 8;
      decipherFn = function(key, iv) {
        return forge.cipher.createDecipher('DES-CBC', key).start({iv: iv});
      };
      break;
    case 'DES-EDE3-CBC':
      dkLen = 24;
      decipherFn = function(key, iv) {
        return forge.cipher.createDecipher('3DES-CBC', key).start({iv: iv});
      };
      break;
    case 'AES-128-CBC':
      dkLen = 16;
      decipherFn = function(key, iv) {
        return forge.cipher.createDecipher('AES-CBC', key).start({iv: iv});
      };
      break;
    case 'AES-192-CBC':
      dkLen = 24;
      decipherFn = function(key, iv) {
        return forge.cipher.createDecipher('AES-CBC', key).start({iv: iv});
      };
      break;
    case 'AES-256-CBC':
      dkLen = 32;
      decipherFn = function(key, iv) {
        return forge.cipher.createDecipher('AES-CBC', key).start({iv: iv});
      };
      break;
    case 'RC2-40-CBC':
      dkLen = 5;
      decipherFn = function(key, iv) {
        return forge.rc2.createDecryptionCipher(key, 40).start(iv);
      };
      break;
    case 'RC2-64-CBC':
      dkLen = 8;
      decipherFn = function(key, iv) {
        return forge.rc2.createDecryptionCipher(key, 64).start(iv);
      };
      break;
    case 'RC2-128-CBC':
      dkLen = 16;
      decipherFn = function(key, iv) {
        return forge.rc2.createDecryptionCipher(key, 128).start(iv);
      };
      break;
    default:
      var error = new Error('Could not decrypt private key; unsupported ' +
        'encryption algorithm "' + msg.dekInfo.algorithm + '".');
      error.algorithm = msg.dekInfo.algorithm;
      throw error;
    }

    // use OpenSSL legacy key derivation
    var iv = new ByteBuffer(msg.dekInfo.parameters, {encoding: 'hex'});
    var dk = evpBytesToKey(password, iv.bytes().substr(0, 8), dkLen);
    var decipher = decipherFn(dk, iv);
    decipher.update(msg.body);
    if(decipher.finish()) {
      rval = decipher.output;
    } else {
      return rval;
    }
  } else {
    rval = msg.body;
  }

  if(msg.type === 'ENCRYPTED PRIVATE KEY') {
    rval = pki.decryptPrivateKeyInfo(asn1.fromDer(rval), password);
  } else {
    // decryption already performed above
    rval = asn1.fromDer(rval);
  }

  if(rval !== null) {
    rval = pki.privateKeyFromAsn1(rval);
  }

  return rval;
};

/**
 * Derives a PKCS#12 key.
 *
 * @param password the password to derive the key material from, null or
 *          undefined for none.
 * @param salt the salt, as a ByteBuffer, to use.
 * @param id the PKCS#12 ID byte (1 = key material, 2 = IV, 3 = MAC).
 * @param iter the iteration count.
 * @param n the number of bytes to derive from the password.
 * @param md the message digest to use, defaults to SHA-1.
 *
 * @return a ByteBuffer with the bytes derived from the password.
 */
pki.pbe.generatePkcs12Key = function(password, salt, id, iter, n, md) {
  if(!(salt instanceof ByteBuffer)) {
    throw new TypeError('salt must be a ByteBuffer.');
  }

  var j, l;

  if(typeof md === 'undefined' || md === null) {
    md = forge.md.sha1.create();
  }

  var u = md.digestLength;
  var v = md.blockLength;
  var result = new ByteBuffer();

  /* Convert password to Unicode byte buffer + trailing 0-byte. */
  var passBuf = new ByteBuffer();
  if(password !== null && password !== undefined) {
    for(l = 0; l < password.length; l++) {
      passBuf.putInt16(password.charCodeAt(l));
    }
    passBuf.putInt16(0);
  }

  /* Length of salt and password in BYTES. */
  var p = passBuf.length();
  var s = salt.length();

  /* 1. Construct a string, D (the "diversifier"), by concatenating
        v copies of ID. */
  var D = new ByteBuffer();
  D.fillWithByte(id, v);

  /* 2. Concatenate copies of the salt together to create a string S of length
        v * ceil(s / v) bytes (the final copy of the salt may be trunacted
        to create S).
        Note that if the salt is the empty string, then so is S. */
  var Slen = v * Math.ceil(s / v);
  var S = new ByteBuffer();
  for(l = 0; l < Slen; l ++) {
    S.putByte(salt.at(l % s));
  }

  /* 3. Concatenate copies of the password together to create a string P of
        length v * ceil(p / v) bytes (the final copy of the password may be
        truncated to create P).
        Note that if the password is the empty string, then so is P. */
  var Plen = v * Math.ceil(p / v);
  var P = new ByteBuffer();
  for(l = 0; l < Plen; l ++) {
    P.putByte(passBuf.at(l % p));
  }

  /* 4. Set I=S||P to be the concatenation of S and P. */
  var I = S;
  I.putBuffer(P);

  /* 5. Set c=ceil(n / u). */
  var c = Math.ceil(n / u);

  /* 6. For i=1, 2, ..., c, do the following: */
  for(var i = 1; i <= c; i ++) {
    /* a) Set Ai=H^r(D||I). (l.e. the rth hash of D||I, H(H(H(...H(D||I)))) */
    var buf = new ByteBuffer();
    buf.putBytes(D.bytes());
    buf.putBytes(I.bytes());
    for(var round = 0; round < iter; round ++) {
      md.start();
      md.update(buf.getBytes());
      buf = md.digest();
    }

    /* b) Concatenate copies of Ai to create a string B of length v bytes (the
          final copy of Ai may be truncated to create B). */
    var B = new ByteBuffer();
    for(l = 0; l < v; l ++) {
      B.putByte(buf.at(l % u));
    }

    /* c) Treating I as a concatenation I0, I1, ..., Ik-1 of v-byte blocks,
          where k=ceil(s / v) + ceil(p / v), modify I by setting
          Ij=(Ij+B+1) mod 2v for each j.  */
    var k = Math.ceil(s / v) + Math.ceil(p / v);
    var Inew = new ByteBuffer();
    for(j = 0; j < k; j ++) {
      var chunk = new ByteBuffer(I.getBytes(v));
      var x = 0x1ff;
      for(l = B.length() - 1; l >= 0; l --) {
        x = x >> 8;
        x += B.at(l) + chunk.at(l);
        chunk.setAt(l, x & 0xff);
      }
      Inew.putBuffer(chunk);
    }
    I = Inew;

    /* Add Ai to A. */
    result.putBuffer(buf);
  }

  result.truncate(result.length() - n);
  return result;
};

/**
 * Get new Forge decipher object instance.
 *
 * @param oid the OID (in string notation).
 * @param params the ASN.1 params object.
 * @param password the password to decrypt with.
 *
 * @return new decipher object instance.
 */
pki.pbe.getDecipher = function(oid, params, password) {
  switch(oid) {
  case pki.oids['pkcs5PBES2']:
    return pki.pbe.getDecipherForPBES2(oid, params, password);

  case pki.oids['pbeWithSHAAnd3-KeyTripleDES-CBC']:
  case pki.oids['pbewithSHAAnd40BitRC2-CBC']:
    return pki.pbe.getDecipherForPKCS12PBE(oid, params, password);

  default:
    var error = new Error(
      'Cannot read encrypted PBE data block. Unsupported OID.');
    error.oid = oid;
    error.supportedOids = [
      'pkcs5PBES2',
      'pbeWithSHAAnd3-KeyTripleDES-CBC',
      'pbewithSHAAnd40BitRC2-CBC'
    ];
    throw error;
  }
};

/**
 * Get new Forge decipher object instance according to PBES2 params block.
 *
 * The returned decipher instance is already started using the IV
 * from PBES2 parameter block.
 *
 * @param oid the PKCS#5 PBKDF2 OID (in string notation).
 * @param params the ASN.1 PBES2-params object.
 * @param password the password to decrypt with.
 *
 * @return new decipher object instance.
 */
pki.pbe.getDecipherForPBES2 = function(oid, params, password) {
  // get PBE params
  var capture = {};
  var errors = [];
  if(!asn1.validate(params, PBES2AlgorithmsValidator, capture, errors)) {
    var error = new Error('Cannot read password-based-encryption algorithm ' +
      'parameters. ASN.1 object is not a supported EncryptedPrivateKeyInfo.');
    error.errors = errors;
    throw error;
  }

  // check oids
  oid = capture.kdfOid;
  if(oid !== pki.oids['pkcs5PBKDF2']) {
    var error = new Error('Cannot read encrypted private key. ' +
      'Unsupported key derivation function OID.');
    error.oid = oid;
    error.supportedOids = ['pkcs5PBKDF2'];
    throw error;
  }
  oid = capture.encOid;
  if(oid !== pki.oids['aes128-CBC'] &&
    oid !== pki.oids['aes192-CBC'] &&
    oid !== pki.oids['aes256-CBC'] &&
    oid !== pki.oids['des-EDE3-CBC'] &&
    oid !== pki.oids['desCBC']) {
    var error = new Error(
      'Cannot read encrypted private key. Unsupported encryption scheme OID.');
    error.oid = oid;
    error.supportedOids = [
      'aes128-CBC', 'aes192-CBC', 'aes256-CBC', 'des-EDE3-CBC', 'desCBC'];
    throw error;
  }

  // set PBE params
  var dkLen;
  var algorithm;
  switch(pki.oids[oid]) {
  case 'aes128-CBC':
    dkLen = 16;
    algorithm = 'AES-CBC';
    break;
  case 'aes192-CBC':
    dkLen = 24;
    algorithm = 'AES-CBC';
    break;
  case 'aes256-CBC':
    dkLen = 32;
    algorithm = 'AES-CBC';
    break;
  case 'des-EDE3-CBC':
    dkLen = 24;
    algorithm = '3DES-CBC';
    break;
  case 'desCBC':
    dkLen = 8;
    algorithm = 'DES-CBC';
    break;
  }

  // decrypt private key using pbe SHA-1 and AES/DES
  var count = capture.kdfIterationCount;
  // FIXME: fix count (is native int)
  count = count.getInt(count.length() << 3);
  var dk = forge.pkcs5.pbkdf2(password, capture.kdfSalt, count, dkLen);
  var cipher = forge.cipher.createDecipher(algorithm, dk);
  return cipher.start({iv: capture.encIv});
};

/**
 * Get new Forge decipher object instance for PKCS#12 PBE.
 *
 * The returned decipher instance is already started using the key & IV
 * derived from the provided password and PKCS#12 PBE salt.
 *
 * @param oid The PKCS#12 PBE OID (in string notation).
 * @param params The ASN.1 PKCS#12 PBE-params object.
 * @param password The password to decrypt with.
 *
 * @return new decipher object instance.
 */
pki.pbe.getDecipherForPKCS12PBE = function(oid, params, password) {
  // get PBE params
  var capture = {};
  var errors = [];
  if(!asn1.validate(params, pkcs12PbeParamsValidator, capture, errors)) {
    var error = new Error('Cannot read password-based-encryption algorithm ' +
      'parameters. ASN.1 object is not a supported EncryptedPrivateKeyInfo.');
    error.errors = errors;
    throw error;
  }

  var salt = capture.salt;
  var count = capture.iterations;
  count = count.getInt(count.length() << 3);

  var dkLen, dIvLen, decipherFn;
  switch(oid) {
    case pki.oids['pbeWithSHAAnd3-KeyTripleDES-CBC']:
      dkLen = 24;
      dIvLen = 8;
      decipherFn = function(key, iv) {
        return forge.cipher.createDecipher('DES-CBC', key).start({iv: iv});
      };
      break;

    case pki.oids['pbewithSHAAnd40BitRC2-CBC']:
      dkLen = 5;
      dIvLen = 8;
      decipherFn = function(key, iv) {
        var cipher = forge.rc2.createDecryptionCipher(key, 40);
        cipher.start(iv, null);
        return cipher;
      };
      break;

    default:
      var error = new Error('Cannot read PKCS #12 PBE data block. Unsupported OID.');
      error.oid = oid;
      throw error;
  }

  var key = pki.pbe.generatePkcs12Key(password, salt, 1, count, dkLen);
  var iv = pki.pbe.generatePkcs12Key(password, salt, 2, count, dIvLen);

  return decipherFn(key, iv);
};

/**
 * OpenSSL's legacy key derivation function.
 *
 * See: http://www.openssl.org/docs/crypto/EVP_BytesToKey.html
 *
 * @param password the password to derive the key from.
 * @param salt the salt to use.
 * @param dkLen the number of bytes needed for the derived key.
 *
 * @return the derived key as a ByteBuffer.
 */
function evpBytesToKey(password, salt, dkLen) {
  var digests = [md5(password + salt)];
  for(var length = 16, i = 1; length < dkLen; ++i, length += 16) {
    digests.push(md5(digests[i - 1] + password + salt));
  }
  return new ByteBuffer(digests.join('').substr(0, dkLen), 'binary');
}

function md5(bytes) {
  return forge.md.md5.create().update(bytes).digest().getBytes();
}

} // end module implementation

/* ########## Begin module wrapper ########## */
var name = 'pbe';
if(typeof define !== 'function') {
  // NodeJS -> AMD
  if(typeof module === 'object' && module.exports) {
    var nodeJS = true;
    define = function(ids, factory) {
      factory(require, module);
    };
  } else {
    // <script>
    if(typeof forge === 'undefined') {
      forge = {};
    }
    return initModule(forge);
  }
}
// AMD
var deps;
var defineFunc = function(require, module) {
  module.exports = function(forge) {
    var mods = deps.map(function(dep) {
      return require(dep);
    }).concat(initModule);
    // handle circular dependencies
    forge = forge || {};
    forge.defined = forge.defined || {};
    if(forge.defined[name]) {
      return forge[name];
    }
    forge.defined[name] = true;
    for(var i = 0; i < mods.length; ++i) {
      mods[i](forge);
    }
    return forge[name];
  };
};
var tmpDefine = define;
define = function(ids, factory) {
  deps = (typeof ids === 'string') ? factory.slice(2) : ids.slice(2);
  if(nodeJS) {
    delete define;
    return tmpDefine.apply(null, Array.prototype.slice.call(arguments, 0));
  }
  define = tmpDefine;
  return define.apply(null, Array.prototype.slice.call(arguments, 0));
};
define([
  'require',
  'module',
  './aes',
  './asn1',
  './des',
  './md',
  './oids',
  './pem',
  './pbkdf2',
  './random',
  './rc2',
  './rsa',
  './util'
], function() {
  defineFunc.apply(null, Array.prototype.slice.call(arguments, 0));
});
})();
