// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Self-test target for the workers web3 workflow: a counter only its owner can bump.
contract Counter {
    address public immutable owner;
    uint256 public count;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function increment() external {
        if (msg.sender != owner) revert NotOwner();
        count += 1;
    }
}
