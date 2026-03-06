// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/HyberRegistry.sol";

contract HyberRegistryTest is Test {
    HyberRegistry reg;

    bytes32 constant TX1 = bytes32(uint256(0xdead));
    bytes32 constant TX2 = bytes32(uint256(0xbeef));

    address constant ALICE = address(0xA11CE);
    address constant BOB   = address(0xB0B);

    function setUp() public {
        reg = new HyberRegistry();
    }

    // -------------------------------------------------------------------------
    // register
    // -------------------------------------------------------------------------

    function test_Register() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        assertEq(reg.resolve("mysite"), TX1);
    }

    function test_RegisterSetsOwner() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        HyberRegistry.Record memory r = reg.getRecord("mysite");
        assertEq(r.owner, ALICE);
        assertEq(r.txHash, TX1);
    }

    function test_RevertDoubleRegister() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.expectRevert(abi.encodeWithSelector(HyberRegistry.AlreadyRegistered.selector, "mysite"));
        vm.prank(BOB);
        reg.register("mysite", TX2);
    }

    function test_RevertEmptyName() public {
        vm.expectRevert(HyberRegistry.EmptyName.selector);
        reg.register("", TX1);
    }

    function test_RevertZeroHash() public {
        vm.expectRevert(HyberRegistry.ZeroHash.selector);
        reg.register("mysite", bytes32(0));
    }

    // -------------------------------------------------------------------------
    // update
    // -------------------------------------------------------------------------

    function test_Update() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.prank(ALICE);
        reg.update("mysite", TX2);
        assertEq(reg.resolve("mysite"), TX2);
    }

    function test_RevertUpdateNotOwner() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.expectRevert(abi.encodeWithSelector(HyberRegistry.NotOwner.selector, "mysite"));
        vm.prank(BOB);
        reg.update("mysite", TX2);
    }

    function test_RevertUpdateZeroHash() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.expectRevert(HyberRegistry.ZeroHash.selector);
        vm.prank(ALICE);
        reg.update("mysite", bytes32(0));
    }

    // -------------------------------------------------------------------------
    // transfer
    // -------------------------------------------------------------------------

    function test_Transfer() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.prank(ALICE);
        reg.transfer("mysite", BOB);

        // BOB can now update
        vm.prank(BOB);
        reg.update("mysite", TX2);
        assertEq(reg.resolve("mysite"), TX2);
    }

    function test_RevertTransferNotOwner() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.expectRevert(abi.encodeWithSelector(HyberRegistry.NotOwner.selector, "mysite"));
        vm.prank(BOB);
        reg.transfer("mysite", BOB);
    }

    function test_OldOwnerLosesAccessAfterTransfer() public {
        vm.prank(ALICE);
        reg.register("mysite", TX1);
        vm.prank(ALICE);
        reg.transfer("mysite", BOB);

        vm.expectRevert(abi.encodeWithSelector(HyberRegistry.NotOwner.selector, "mysite"));
        vm.prank(ALICE);
        reg.update("mysite", TX2);
    }

    // -------------------------------------------------------------------------
    // resolve
    // -------------------------------------------------------------------------

    function test_ResolveUnregisteredReturnsZero() public view {
        assertEq(reg.resolve("nonexistent"), bytes32(0));
    }
}
