import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concatHex, encodeAbiParameters, getAddress, keccak256, toBytes, zeroAddress } from "viem";
import { EXECUTE_SELECTOR } from "./chain";
import {
  KERNEL_ENABLE_TYPEHASH,
  enableDataFor,
  enableDigest,
  packEnableSignature,
  permissionIdFor,
  permissionNonceKey,
  validationIdFor,
} from "./sponsorship";

const policy = getAddress("0x1111111111111111111111111111111111111111");
const sessionKey = getAddress("0x2222222222222222222222222222222222222222");

describe("session permission", () => {
  it("uses the Kernel enable typehash", () => {
    const hashed = keccak256(
      toBytes("Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)"),
    );
    assert.equal(hashed, KERNEL_ENABLE_TYPEHASH);
  });

  it("builds a 4-byte permission id and a 21-byte validation id", () => {
    const permissionId = permissionIdFor(policy, sessionKey);
    assert.equal(permissionId.length, 10);
    const validationId = validationIdFor(permissionId);
    assert.equal(validationId.length, 44);
    assert.ok(validationId.startsWith("0x02"));
    const key = permissionNonceKey("0x01", permissionId);
    assert.ok(key < 1n << 192n);
    assert.equal(key >> 184n, 1n);
    assert.equal((key >> 176n) & 0xffn, 2n);
  });

  it("packs the enable signature the way Kernel reads it", () => {
    const enableData = enableDataFor(policy, sessionKey);
    const packed = packEnableSignature(enableData, "0xaaaa", "0xffbbbb");
    assert.equal(packed.slice(0, 42), `0x${"0".repeat(40)}`);
    assert.ok(packed.includes(EXECUTE_SELECTOR.slice(2)));
    assert.ok(packed.includes("ffbbbb"));
  });

  it("hashes the enable digest the way Kernel does", () => {
    const account = getAddress("0xb40Ffe6974eE586a1CfE19E24E7Aac1BD6077EF4");
    const validationId = validationIdFor(permissionIdFor(policy, sessionKey));
    const validatorData = enableDataFor(policy, sessionKey);
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes21" },
          { type: "uint32" },
          { type: "address" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [
          KERNEL_ENABLE_TYPEHASH,
          validationId,
          1,
          zeroAddress,
          keccak256(validatorData),
          keccak256("0x"),
          keccak256(EXECUTE_SELECTOR),
        ],
      ),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toBytes("Kernel")),
          keccak256(toBytes("0.3.1")),
          44005n,
          account,
        ],
      ),
    );
    const manual = keccak256(concatHex(["0x1901", domainSeparator, structHash]));
    assert.equal(
      enableDigest({ account, validationId, nonce: 1, validatorData }),
      manual,
    );
  });
});
