package main

import (
	"math/rand"
	"strconv"
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

func doSomething() []string {
	slice := make([]string, 0)
	s := "hello" + strconv.Itoa(rand.Intn(1000))
	for range 1000 {
		slice = append(slice, s)
	}
	return slice
}

func BenchmarkSlicePreAllocate(b *testing.B) {
	for i := 0; i < b.N; i++ {
		doSomething()
	}
}

func BenchmarkSliceNoPreAllocate(b *testing.B) {
	var slice []string
	for i := 0; i < b.N; i++ {
		slice = append(slice, "no-pre-allocate")
	}
}
