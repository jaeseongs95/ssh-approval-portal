[Console]::Error.WriteLine($_.ToString());if($_.InvocationInfo -and $_.InvocationInfo.PositionMessage){[Console]::Error.WriteLine($_.InvocationInfo.PositionMessage)};
