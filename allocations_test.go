package main

import (
	"sync"
	"testing"
)

func BenchmarkChannelOperations(b *testing.B) {
	ch := make(chan int, 100)

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			ch <- 1
			<-ch
		}
	})
}

func BenchmarkMutexOperations(b *testing.B) {
	var mu sync.Mutex
	var counter int

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			mu.Lock()
			counter++
			mu.Unlock()
		}
	})
}

func BenchmarkSlicePreAllocate(b *testing.B) {
	slice := make([]string, 0, b.N)
	for i := 0; i < b.N; i++ {
		slice = append(slice, "pre-allocated")
	}
}

func BenchmarkSliceNoPreAllocate(b *testing.B) {
	var slice []string
	for i := 0; i < b.N; i++ {
		slice = append(slice, "no-pre-allocate")
	}
}
