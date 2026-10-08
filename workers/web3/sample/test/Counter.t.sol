// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Counter} from "../src/Counter.sol";

interface Vm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

contract CounterTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Counter private counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_ownerIncrements() public {
        counter.increment();
        require(counter.count() == 1, "count");
    }

    function test_strangerIsRefused() public {
        VM.prank(address(0xBEEF));
        VM.expectRevert(Counter.NotOwner.selector);
        counter.increment();
    }
}
