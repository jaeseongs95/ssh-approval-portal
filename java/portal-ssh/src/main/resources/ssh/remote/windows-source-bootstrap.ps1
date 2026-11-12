& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('@@PACKED@@')),[IO.Compression.CompressionMode]0)).ReadToEnd()))
