// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Counter} from "../src/Counter.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// The workflow runs this with --sender and never hands it a key: locally against anvil (unlocked dev account) and as a
/// dry run against the testnet, whose plan the publish job signs.
contract Deploy {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (Counter counter) {
        VM.startBroadcast();
        counter = new Counter();
        counter.increment();
        VM.stopBroadcast();
    }
}
