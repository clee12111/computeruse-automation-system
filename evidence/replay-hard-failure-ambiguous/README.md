# Hard Failure: Ambiguous Selector Match

This proves that when multiple candidates score identically, the margin gate refuses to proceed and returns HARD_FAILURE. The transcript shows two competing matches with equal confidence; neither crosses the confidence threshold. This demonstrates deterministic rejection of ambiguous states.
