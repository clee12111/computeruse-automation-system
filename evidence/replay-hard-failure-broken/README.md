# Hard Failure: Counterfactual Drift

This proves that drift from expected behavior (counterfactual scenario) triggers HARD_FAILURE. The artifact assumes UI state that no longer exists; replay fails to match any selector at a critical step. Check the drift detection logic to see how mismatches are identified and why escalation did not recover.
