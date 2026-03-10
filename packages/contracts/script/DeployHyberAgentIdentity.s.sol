// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HyberAgentIdentity.sol";

contract DeployHyberAgentIdentity is Script {
    function run() external {
        vm.startBroadcast();
        HyberAgentIdentity identity = new HyberAgentIdentity();
        vm.stopBroadcast();

        console2.log("HyberAgentIdentity deployed at:", address(identity));
        console2.log("Set AGENT_IDENTITY_ADDRESS =", address(identity));
    }
}
