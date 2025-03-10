const assert = require('assert');

const { parseSignature } = require('./signature');
const put = require('@nornagon/put');
const Marshallers = require('./marshallers');
const align = require('./align').align;

module.exports = function marshall (signature, data, offset, fds) {
  if (typeof offset === 'undefined') offset = 0;
  const tree = parseSignature(signature);
  if (!Array.isArray(data) || data.length !== tree.length) {
    throw new Error(
      `message body does not match message signature. Body:${JSON.stringify(
        data
      )}, signature:${signature}`
    );
  }
  const putstream = put();
  putstream._offset = offset;
  const buf = writeStruct(putstream, tree, data, fds).buffer();
  return buf;
};

// TODO: serialise JS objects as a{sv}
// function writeHash(ps, treeKey, treeVal, data) {
//
// }

function writeStruct (ps, tree, data, fds) {
  if (tree.length !== data.length) {
    throw new Error('Invalid struct data');
  }
  for (let i = 0; i < tree.length; ++i) {
    write(ps, tree[i], data[i], fds);
  }
  return ps;
}

function write (ps, ele, data, fds) {
  switch (ele.type) {
    case '(':
    case '{':
      align(ps, 8);
      writeStruct(ps, ele.child, data, fds);
      break;
    case 'a': {
      // array serialisation:
      // length of array body aligned at 4 byte boundary
      // (optional 4 bytes to align first body element on 8-byte boundary if element
      // body
      const arrPut = put();
      arrPut._offset = ps._offset;
      const _offset = arrPut._offset;
      writeSimple(arrPut, 'u', 0); // array length placeholder
      const lengthOffset = arrPut._offset - 4 - _offset;
      // we need to align here because alignment is not included in array length
      if (['x', 't', 'd', '{', '('].indexOf(ele.child[0].type) !== -1) { align(arrPut, 8); }
      const startOffset = arrPut._offset;
      for (let i = 0; i < data.length; ++i) { write(arrPut, ele.child[0], data[i], fds); }
      const arrBuff = arrPut.buffer();
      const length = arrPut._offset - startOffset;
      // lengthOffset in the range 0 to 3 depending on number of align bytes padded _before_ arrayLength
      arrBuff.writeUInt32LE(length, lengthOffset);
      ps.put(arrBuff);
      ps._offset += arrBuff.length;
      break;
    } case 'v': {
      // TODO: allow serialisation of simple types as variants, e. g 123 -> ['u', 123], true -> ['b', 1], 'abc' -> ['s', 'abc']
      assert.strictEqual(data.length, 2, 'variant data should be [signature, data]');
      const signatureEle = {
        type: 'g',
        child: []
      };
      write(ps, signatureEle, data[0], fds);
      const tree = parseSignature(data[0]);
      assert(tree.length === 1);
      write(ps, tree[0], data[1], fds);
      break;
    } case 'h': {
      if (fds) {
        const idx = fds.push(data);
        return writeSimple(ps, ele.type, idx - 1);
      }
      return writeSimple(ps, ele.type, data);
    }
    default:
      return writeSimple(ps, ele.type, data);
  }
}

const stringTypes = ['g', 'o', 's'];

function writeSimple (ps, type, data) {
  if (typeof data === 'undefined') {
    throw new Error(
      "Serialisation of JS 'undefined' type is not supported by d-bus"
    );
  }
  if (data === null) { throw new Error('Serialisation of null value is not supported by d-bus'); }

  if (Buffer.isBuffer(data)) data = data.toString(); // encoding?
  if (stringTypes.indexOf(type) !== -1 && typeof data !== 'string') {
    throw new Error(
      `Expected string or buffer argument, got ${JSON.stringify(
        data
      )} of type '${type}'`
    );
  }

  const simpleMarshaller = Marshallers.MakeSimpleMarshaller(type);
  simpleMarshaller.marshall(ps, data);
  return ps;
}
