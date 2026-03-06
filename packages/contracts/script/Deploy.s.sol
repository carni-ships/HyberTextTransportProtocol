// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HyberRegistry.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        HyberRegistry registry = new HyberRegistry();
        vm.stopBroadcast();
        console2.log("HyberRegistry deployed at:", address(registry));
    }
}
